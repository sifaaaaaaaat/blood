-- ============================================================================
-- Migration 0023: WhatsApp donor conversation flow.
--
-- What this adds (the flow the owner asked for):
--   request submitted -> nearby donors get a WhatsApp ask -> donor accepts in
--   WhatsApp -> donor is asked whether they donated in the last 3 months ->
--   only a donor who has NOT given blood recently stays confirmed, and their
--   contact becomes revealable to the requester.
--
-- Design notes / hard rules kept intact:
--   · The donor's reply is authenticated by POSSESSION of the number: the
--     inbound webhook resolves the sender's number to a profile, and the
--     match that can be acted on is only ever the one bound to that donor.
--   · No message content is persisted; only stage transitions are.
--   · The 3-month rule is a SELF-REPORTED cooldown, not a medical
--     eligibility judgment. Matching already refuses to claim eligibility.
--   · whatsapp_match_sessions has RLS enabled with NO policies: only the
--     service role (the webhook) can read or write it.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Matches may now be answered through WhatsApp.
-- ---------------------------------------------------------------------------
alter table public.request_matches
  drop constraint if exists request_matches_response_source_check;

alter table public.request_matches
  add constraint request_matches_response_source_check
  check (response_source is null or response_source in ('in_app', 'action_token', 'whatsapp'));

-- ---------------------------------------------------------------------------
-- 2. Conversation stage per match (service-role only).
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_match_sessions (
  match_id   uuid primary key references public.request_matches (id) on delete cascade,
  donor_id   uuid not null references public.profiles (id) on delete cascade,
  -- awaiting_accept: ask sent, waiting for 1/2
  -- awaiting_donation_gap: accepted, waiting for the 3-month question 1/2
  -- done: conversation finished (accepted+cleared, declined, or ineligible)
  stage      text not null default 'awaiting_accept'
             check (stage in ('awaiting_accept', 'awaiting_donation_gap', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists whatsapp_match_sessions_donor_idx
  on public.whatsapp_match_sessions (donor_id, stage);

alter table public.whatsapp_match_sessions enable row level security;
-- deliberately NO policies: this table is invisible to anon/authenticated.

do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgname = 'whatsapp_match_sessions_touch'
       and tgrelid = 'public.whatsapp_match_sessions'::regclass
  ) then
    create trigger whatsapp_match_sessions_touch
      before update on public.whatsapp_match_sessions
      for each row execute function public.touch_updated_at();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Donor answered "yes, I donated in the last 3 months" on WhatsApp.
--
-- Records the self-reported donation (so the history is honest — it is NOT a
-- verified donation) and pauses the donor for three months, which takes them
-- out of candidate matching both via paused_until and via last_donation_date.
--
-- Called ONLY by the inbound webhook with the donor resolved from the sender's
-- own number, hence service-role-only and an explicit donor id.
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_declare_recent_donation(p_donor uuid)
returns table (ok boolean, message text, paused_until date)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_until date;
begin
  if p_donor is null or not exists (select 1 from public.profiles p where p.id = p_donor) then
    return query select false, 'unknown donor', null::date;
    return;
  end if;

  v_until := (current_date + interval '3 months')::date;

  -- One record per (donor, date, type) — a retry must not duplicate history.
  if not exists (
    select 1 from public.donation_records r
     where r.donor_id = p_donor
       and r.donation_date = current_date
       and r.donation_type::text = 'whole_blood'
  ) then
    insert into public.donation_records
      (donor_id, donation_date, donation_type, report_note, source)
    values
      (p_donor, current_date, 'whole_blood'::public.donation_type,
       'Reported by the donor in the WhatsApp eligibility question', 'self_reported');
  end if;

  update public.donor_profiles
     set last_donation_date = current_date,
         availability = 'paused',
         paused_until = v_until,
         updated_at = now()
   where user_id = p_donor;

  perform public.append_audit_log('donor.whatsapp_recent_donation',
    jsonb_build_object('donor', p_donor, 'paused_until', v_until), p_donor);

  return query select true, 'donor paused for three months after a self-reported donation', v_until;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Release an ALREADY-ACCEPTED match when the donor turns out to be inside
--    the 3-month window. donor_respond_match only moves pending/notified rows,
--    so this explicit transition is required; it is audited like the others.
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_release_match_after_ineligible(
  p_match_id uuid,
  p_donor    uuid
)
returns table (ok boolean, new_status public.match_status, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.request_matches%rowtype;
begin
  select * into m from public.request_matches where id = p_match_id for update;
  if not found then
    return query select false, null::public.match_status, 'match not found';
    return;
  end if;
  if m.donor_id <> p_donor then
    return query select false, null::public.match_status, 'not your match';
    return;
  end if;
  if m.status not in ('accepted', 'pending', 'notified') then
    return query select false, m.status, 'already responded';
    return;
  end if;

  update public.request_matches
     set status = 'unavailable',
         responded_at = now(),
         response_source = 'whatsapp',
         updated_at = now()
   where id = m.id;

  perform public.append_audit_log('match.released_recent_donation',
    jsonb_build_object('match_id', m.id, 'request_id', m.request_id), p_donor);

  return query select true, 'unavailable'::public.match_status, null::text;
end $$;

-- Both RPCs are for the trusted webhook only.
revoke execute on function public.whatsapp_declare_recent_donation(uuid) from anon, authenticated;
revoke execute on function public.whatsapp_release_match_after_ineligible(uuid, uuid) from anon, authenticated;
grant execute on function public.whatsapp_declare_recent_donation(uuid) to service_role;
grant execute on function public.whatsapp_release_match_after_ineligible(uuid, uuid) to service_role;

commit;
