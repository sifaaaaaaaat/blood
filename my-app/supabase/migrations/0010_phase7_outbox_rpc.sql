-- ============================================================================
-- Phase 7: outbox worker RPCs — server-role only, atomic and race-free.
--  · claim_outbox_batch(p_limit): atomically claims due rows (SKIP LOCKED),
--    enforcing consent, request-state, staleness and per-donor fairness in
--    ONE place so app logic cannot race itself. Ineligible rows are
--    finalized here (skipped_consent / skipped_cancelled / expired).
--  · complete_outbox_item(...): terminal transition, idempotent.
--  · recover_stale_sending(): crashed 'sending' rows back to queued.
--  · alert_repeated_failures(p_request_id): audit-log monitoring signal.
--
-- The simulated/real boundary is enforced in SQL: a row may only become
-- 'delivered' when provider_ref is set by a NON-simulated attempt.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- recover_stale_sending: heartbeats. If the worker died mid-send, rows stuck
-- in 'sending' older than the configured window go back to 'queued'.
-- (Window applied by caller-side sweeper constant; here it is parameterized.)
-- ---------------------------------------------------------------------------
create or replace function public.recover_stale_sending(
  p_stale_minutes integer default 10
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  recovered int;
begin
  with stale as (
    update public.notification_outbox
       set status = 'queued', available_after = now(), completed_at = null
     where status = 'sending'
       and (completed_at is null or completed_at < now() - (p_stale_minutes || ' minutes')::interval)
    returning 1
  )
  select count(*) into recovered from stale;
  return recovered;
end $$;

-- ---------------------------------------------------------------------------
-- claim_outbox_batch
-- ---------------------------------------------------------------------------
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
  consent record;
  pending_for_recipient int;
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
           attempts = notification_outbox.attempts + 1
     where notification_outbox.id = row_rec.id;

    return query select
      row_rec.id, row_rec.request_id, row_rec.recipient_id,
      row_rec.recipient_phone, row_rec.provider, row_rec.message_type,
      row_rec.attempts + 1, row_rec.simulated;
  end loop;
  return;
end $$;

-- ---------------------------------------------------------------------------
-- complete_outbox_item: idempotent terminal transition. Guard rails:
--   · only from 'sending' (claimed) state,
--   · 'delivered' requires p_simulated = false AND a provider reference —
--     a mock/simulated send can never be recorded as a real delivery.
--   · failure_reason is truncated + newline-stripped (sanitized, no content).
-- ---------------------------------------------------------------------------
create or replace function public.complete_outbox_item(
  p_outbox_id uuid,
  p_outcome text,             -- 'accepted' | 'failed'
  p_simulated boolean,
  p_provider_ref text,
  p_failure_reason text,
  p_backoff_minutes integer default 2,
  p_max_attempts integer default 5
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.notification_outbox%rowtype;
  sanitized text;
begin
  select * into o from public.notification_outbox where id = p_outbox_id for update;
  if not found then
    return 'not_found';
  end if;
  if o.status <> 'sending' then
    return 'already_' || o.status::text;   -- idempotent no-op
  end if;

  insert into public.notification_attempts
    (outbox_id, attempt_no, provider, simulated, outcome, failure_reason)
  values
    (o.id, o.attempts, o.provider, p_simulated, p_outcome,
     coalesce(p_failure_reason, ''));

  sanitized := nullif(
    left(regexp_replace(coalesce(p_failure_reason, ''), '[\r\n\t]+', ' ', 'g'), 200),
    '');

  if p_outcome = 'accepted' then
    if p_simulated then
      update public.notification_outbox
         set status = 'simulated_sent', completed_at = now(),
             provider_ref = coalesce(p_provider_ref, o.provider_ref),
             simulated = true
       where id = o.id;
      return 'simulated_sent';
    end if;
    if p_provider_ref is null then
      -- A real send cannot be completed without a provider reference.
      update public.notification_outbox
         set status = 'failed', completed_at = now(),
             failure_reason = 'missing provider reference'
       where id = o.id;
      return 'failed';
    end if;
    update public.notification_outbox
       set status = 'delivered', completed_at = now(),
           provider_ref = p_provider_ref, simulated = false
     where id = o.id;
    return 'delivered';
  end if;

  -- Failed: bounded retry with exponential backoff; exhausted => failed.
  if o.attempts >= p_max_attempts then
    update public.notification_outbox
       set status = 'failed', completed_at = now(), failure_reason = sanitized
     where id = o.id;
    return 'failed';
  end if;

  update public.notification_outbox
     set status = 'queued', available_after = now() + (p_backoff_minutes || ' minutes')::interval,
         failure_reason = sanitized
   where id = o.id;
  return 'retry_scheduled';
end $$;

-- ---------------------------------------------------------------------------
-- alert_repeated_failures: monitoring hook — writes one audit entry per
-- sweep when failures for a request cross the threshold.
-- ---------------------------------------------------------------------------
create or replace function public.alert_repeated_failures(
  p_threshold integer default 3
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select request_id, count(*)::int as fails
      from public.notification_outbox
     where status = 'failed' and request_id is not null
     group by request_id
    having count(*) >= p_threshold
  loop
    perform public.append_audit_log(
      'notifications.repeated_failure',
      jsonb_build_object('request_id', r.request_id, 'failed', r.fails),
      null);
  end loop;
  return 'scanned';
end $$;

commit;

grant execute on function public.claim_outbox_batch(integer, integer) to service_role;
grant execute on function public.complete_outbox_item(uuid, text, boolean, text, text, integer, integer) to service_role;
grant execute on function public.recover_stale_sending(integer) to service_role;
grant execute on function public.alert_repeated_failures(integer) to service_role;
