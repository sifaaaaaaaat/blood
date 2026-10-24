-- ============================================================================
-- Fix: outbox send-time phone resolution.
--
-- Rows were being enqueued with recipient_phone NULL and the only phone on
-- record for a donor lives in public.contact_numbers (E.164 +8801XXXXXXXXX,
-- checked by a DB constraint). claim_outbox_batch returned the outbox's
-- NULL, so real providers had no recipient address and every send failed
-- with "no valid recipient phone on record".
--
-- Change: at claim time, fall back to the recipient's most recent contact
-- number (prefer a verified one) and persist it onto the outbox row for
-- forensics. Phone content never leaves the server: the RPC is service-role
-- only and the outbox table has RLS with zero policies.
-- ============================================================================

begin;

create or replace function public.claim_outbox_batch(
  p_limit integer default 20,
  p_per_recipient_limit integer default 5
)
returns table (
  id uuid,
  request_id uuid,
  recipient_id uuid,
  recipient_phone text,
  provider text,
  message_type text,
  attempts int,
  simulated boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  row_rec record;
  req public.blood_requests%rowtype;
  pending_for_recipient int;
  v_phone text;
begin
  perform public.recover_stale_sending();

  for row_rec in
    select * from public.notification_outbox
    where status = 'queued' and available_after <= now()
    order by created_at
    limit p_limit * 3          -- probe extra; fairness may drop some
    for update skip locked
  loop
    -- Hard TTL: stale queued rows expire instead of looping forever.
    if row_rec.expires_at < now() then
      update public.notification_outbox
         set status = 'expired', completed_at = now()
       where notification_outbox.id = row_rec.id;
      continue;
    end if;

    select * into req from public.blood_requests where blood_requests.id = row_rec.request_id;
    if not found or req.status in ('cancelled','expired','flagged','fulfilled') then
      update public.notification_outbox
         set status = 'skipped_cancelled', completed_at = now()
       where notification_outbox.id = row_rec.id;
      continue;
    end if;

    -- Opt-out enforcement at SEND time (not only enqueue time): consent can
    -- be revoked between enqueue and send.
    if not coalesce(
      exists (
        select 1 from public.donor_profiles dp
        where dp.user_id = row_rec.recipient_id and dp.notify_consent = true
      ), false) then
      update public.notification_outbox
         set status = 'skipped_consent', completed_at = now()
       where notification_outbox.id = row_rec.id;
      continue;
    end if;

    -- Resolve the recipient's phone at send time (latest contact number,
    -- preferring a verified one). Empty => skip silently as consent-skipped;
    -- there is nothing a retry could do better than a re-enqueue.
    select cn.phone_normalized into v_phone
      from public.contact_numbers cn
     where cn.user_id = row_rec.recipient_id
       and cn.phone_normalized is not null
     order by (cn.verified_at is not null) desc, cn.created_at desc
     limit 1;

    if v_phone is null and row_rec.recipient_phone is null then
      update public.notification_outbox
         set status = 'skipped_consent', completed_at = now(),
             failure_reason = 'no contact number on record'
       where notification_outbox.id = row_rec.id;
      continue;
    end if;

    -- Per-donor fairness: skip if this recipient already has too many
    -- pending rows. NOT finalized — stays queued for a later sweep.
    select count(*) into pending_for_recipient
      from public.notification_outbox o
     where o.recipient_id = row_rec.recipient_id
       and o.status = 'sending';
    if pending_for_recipient >= p_per_recipient_limit then
      continue;
    end if;

    update public.notification_outbox
       set status = 'sending',
           attempts = notification_outbox.attempts + 1,
           recipient_phone = coalesce(row_rec.recipient_phone, v_phone)
     where notification_outbox.id = row_rec.id;

    return query select
      row_rec.id, row_rec.request_id, row_rec.recipient_id,
      coalesce(row_rec.recipient_phone, v_phone),
      row_rec.provider, row_rec.message_type,
      row_rec.attempts + 1, row_rec.simulated;
  end loop;
  return;
end $$;

-- Re-assert grants (function replaced; idempotent).
grant execute on function public.claim_outbox_batch(integer, integer) to service_role;

commit;
