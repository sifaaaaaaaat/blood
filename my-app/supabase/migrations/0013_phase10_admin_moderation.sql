-- ============================================================================
-- Migration 0013: Phase 10 — Administration, Moderation and Platform Trust
--
-- HARD DESIGN RULES (do not weaken without the owner's sign-off):
--  · Server-verified roles ONLY: authorization checks live inside the DB
--    (auth.uid() + profiles.is_admin / active platform_roles row). The app's
--    session flags are convenience pre-checks; they can never BE the check.
--  · Moderators are a RESTRICTED role. They cannot: grant/revoke roles,
--    change platform settings, reinstate disabled accounts, or touch
--    clinical configuration (recovery rules remain admin + medical-approver
--    gated from Phase 8).
--  · Account disabling is a moderation action with a review process:
--    staff disable -> user may request review -> only an ADMIN reinstates.
--    Disabled accounts are denied at the DB layer (RLS gates on writes +
--    explicit checks in the acceptance/reveal functions), not just in app
--    code that could be bypassed by direct PostgREST calls.
--  · Least-privilege data access: admin/moderator inspection endpoints and
--    functions return minimal fields. Phone contact data (contact_numbers)
--    is never SELECTable by any role directly; duplicate-profile fraud
--    detection exposes a CORRELATION FLAG, never the number.
--  · Rate limits are server-side and account-keyed. No device fingerprints,
--    no IPs, no unrelated personal data are collected for abuse detection.
--  · Every staff action is written to the append-only audit log with actor,
--    action, target and minimal metadata (ids/counts — no PII).
--  · Platform settings are NON-CLINICAL by construction: the category
--    constraint excludes anything clinical, and setting changes are audited.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- platform_roles: grantable staff roles on top of the base is_admin flag.
-- One row per user; revocation is recorded, never destructive (audit trail).
-- ---------------------------------------------------------------------------
create table if not exists public.platform_roles (
  user_id       uuid primary key references public.profiles (id) on delete cascade,
  is_moderator  boolean not null default true,
  granted_by    uuid references public.profiles (id),
  granted_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  note          text
);

alter table public.platform_roles enable row level security;

-- A user may read their OWN active role (the app uses this for the session
-- "flag", which is pre-check only — the DB re-verifies everywhere else).
do $$
begin
  if not exists (select 1 from pg_policies where tablename='platform_roles' and policyname='platform_roles_select_own') then
    create policy platform_roles_select_own on public.platform_roles
      for select to authenticated
      using (user_id = auth.uid());
  end if;
end $$;

-- Writes happen only through admin_* functions below (security definer).
revoke insert, update, delete on public.platform_roles from anon, authenticated;
grant select on public.platform_roles to authenticated;

-- ---------------------------------------------------------------------------
-- Central role checks (server-verified). These are the ONLY role probes used
-- by Phase 10 functions. A falsified client session flag cannot pass them.
-- ---------------------------------------------------------------------------
create or replace function public.app_is_admin(p_user uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select coalesce(
    (select is_admin from public.profiles where id = p_user), false)
$$;

create or replace function public.app_is_moderator(p_user uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select coalesce(
    (select is_moderator from public.platform_roles
      where user_id = p_user and revoked_at is null), false)
$$;

create or replace function public.app_is_staff(p_user uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select public.app_is_admin(p_user) or public.app_is_moderator(p_user)
$$;

-- ---------------------------------------------------------------------------
-- abuse_reports: user-facing reports. Reporters see their own rows; staff
-- review happens EXCLUSIVELY through the RPC (least-privilege inspection).
-- The table is never directly readable by staff over PostgREST.
-- ---------------------------------------------------------------------------
create table if not exists public.abuse_reports (
  id              uuid primary key default gen_random_uuid(),
  reporter_id     uuid not null references public.profiles (id) on delete cascade,
  target_type     text not null check (target_type in
                    ('blood_request','donor_profile','requester_profile','in_app_contact','other')),
  target_id       uuid,                   -- null allowed for 'other'
  category        text not null check (category in
                    ('spam','harassment','fake_profile','suspicious_request','contact_abuse','other')),
  detail          text check (char_length(detail) <= 500),
  status          text not null default 'open'
                    check (status in ('open','reviewing','actioned','dismissed')),
  handled_by      uuid references public.profiles (id),
  handled_at      timestamptz,
  resolution_note text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists abuse_reports_status_idx on public.abuse_reports (status, created_at desc);
create index if not exists abuse_reports_reporter_idx on public.abuse_reports (reporter_id);

alter table public.abuse_reports enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='abuse_reports' and policyname='abuse_reports_insert_own') then
    create policy abuse_reports_insert_own on public.abuse_reports
      for insert to authenticated
      with check (reporter_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename='abuse_reports' and policyname='abuse_reports_select_own') then
    create policy abuse_reports_select_own on public.abuse_reports
      for select to authenticated
      using (reporter_id = auth.uid());
  end if;
end $$;

revoke update, delete on public.abuse_reports from anon, authenticated;
grant insert, select on public.abuse_reports to authenticated;

-- Audit every filed report (id-only metadata). Trigger functions must return
-- `trigger`, so a small wrapper wraps the append-only audit helper.
create or replace function public.abuse_report_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.append_audit_log(
    'abuse.report_filed',
    jsonb_build_object('report_id', new.id, 'target_type', new.target_type, 'target_id', new.target_id));
  return new;
end $$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'abuse_reports_filed_audit') then
    create trigger abuse_reports_filed_audit after insert
      on public.abuse_reports
      for each row execute function public.abuse_report_audit();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- account_status: moderation-managed disabling + due review process.
-- status: 'active' (default), 'disabled' (staff action), 'suspended' (admin).
-- Enforcement is DB-side: see the rewritten RLS insert/update policies for
-- blood_requests and explicit checks in donor_respond_match / reveal_contact.
-- ---------------------------------------------------------------------------
create table if not exists public.account_status (
  user_id             uuid primary key references public.profiles (id) on delete cascade,
  status              text not null default 'active'
                        check (status in ('active','disabled','suspended')),
  disabled_by         uuid references public.profiles (id),
  disabled_at         timestamptz,
  reason              text check (char_length(reason) <= 500),
  review_requested_at timestamptz,
  review_by           uuid references public.profiles (id),
  review_note         text,
  resolved_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.account_status enable row level security;

-- Account owner may see their own moderation status (and nothing else's).
do $$
begin
  if not exists (select 1 from pg_policies where tablename='account_status' and policyname='account_status_select_own') then
    create policy account_status_select_own on public.account_status
      for select to authenticated
      using (user_id = auth.uid());
  end if;
end $$;

-- All writes via RPCs. No insert/update/delete grants for clients.
revoke insert, update, delete on public.account_status from anon, authenticated;
grant select on public.account_status to authenticated;

-- ---------------------------------------------------------------------------
-- platform_settings: NON-CLINICAL operational configuration only.
-- The category whitelist is the clinical firewall — 'clinical' (or anything
-- medical) simply cannot be expressed, so no client key can smuggle a
-- clinical decision through this table.
-- ---------------------------------------------------------------------------
create table if not exists public.platform_settings (
  key        text primary key,
  value      jsonb not null,
  category   text not null check (category in ('rate_limits','moderation','operational')),
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.platform_settings enable row level security;
-- server-only surface (same pattern as notification_outbox): no policies =>
-- invisible to anon/authenticated over PostgREST; reads/writes via service
-- role or audited RPCs.
revoke all on public.platform_settings from anon, authenticated;

-- Seed the known rate-limit keys with safe defaults (idempotent).
insert into public.platform_settings (key, value, category)
values
  ('rate_limits.request_create_per_day',     '15'::jsonb, 'rate_limits'),
  ('rate_limits.contact_reveal_per_day',     '20'::jsonb, 'rate_limits'),
  ('rate_limits.candidate_list_per_day',    '100'::jsonb, 'rate_limits'),
  ('rate_limits.accept_bypass_refusal_per_day','60'::jsonb, 'rate_limits'),
  ('rate_limits.abuse_report_per_day',       '10'::jsonb, 'rate_limits')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- abuse_counters: per-account per-day rate-limit buckets. Collection is
-- account-scoped only (user id + action label + day) — no device data, no IP,
-- no freeform personal data: the minimum needed for server-side abuse control.
-- ---------------------------------------------------------------------------
create table if not exists public.abuse_counters (
  subject_id uuid not null,
  scope      text not null,
  bucket     date not null default date_trunc('day', now())::date,
  count      integer not null default 0,
  last_at    timestamptz not null default now(),
  primary key (subject_id, scope, bucket)
);

create index if not exists abuse_counters_day_idx on public.abuse_counters (bucket, count desc);

alter table public.abuse_counters enable row level security;
revoke all on public.abuse_counters from anon, authenticated;

-- ---------------------------------------------------------------------------
-- bump_abuse_counter: single authorization point for every server-side
-- counter. Cap is read from platform_settings (key
-- rate_limits.<scope>_per_day) with a known-scope default; refusing trips an
-- audit entry. Returns the (possibly last-allowed) decision to the caller.
-- ---------------------------------------------------------------------------
create or replace function public.bump_abuse_counter(
  p_subject uuid,
  p_scope   text
)
returns table (allowed boolean, cnt integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cap     integer;
  v_count   integer;
begin
  select coalesce((select (s.value #>> '{}')::int
                   from public.platform_settings s
                    where s.key = 'rate_limits.' || p_scope || '_per_day'), null)
    into v_cap;

  insert into public.abuse_counters (subject_id, scope, bucket, count, last_at)
  values (p_subject, p_scope, date_trunc('day', now())::date, 1, now())
  on conflict (subject_id, scope, bucket)
  do update set count = public.abuse_counters.count + 1, last_at = now()
  returning public.abuse_counters.count into v_count;

  if v_cap is null then
    -- Unknown scope: fail CLOSED. A missing cap key is a moderation failure,
    -- never a silent bypass.
    return query select false, v_count;
    return;
  end if;

  if v_count > v_cap then
    perform public.append_audit_log(
      'abuse.limit_tripped',
      jsonb_build_object('subject', p_subject, 'scope', p_scope, 'count', v_count, 'cap', v_cap),
      p_subject);
    return query select false, v_count;
    return;
  end if;

  return query select true, v_count;
end $$;

revoke execute on function public.bump_abuse_counter(uuid, text) from anon;
grant execute on function public.bump_abuse_counter(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Admin: grant/revoke a moderator (admin-only; audited).
-- ---------------------------------------------------------------------------
create or replace function public.admin_grant_moderator(p_user uuid, p_note text default null)
returns table (ok boolean, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not public.app_is_admin(me) then
    return query select false, 'admin only';
    return;
  end if;
  if p_user is null then
    return query select false, 'user required';
    return;
  end if;
  insert into public.platform_roles (user_id, is_moderator, granted_by, note)
  values (p_user, true, me, p_note)
  on conflict (user_id) do update
    set is_moderator = true, revoked_at = null, granted_by = me, note = coalesce(p_note, public.platform_roles.note);
  perform public.append_audit_log(
    'moderator.granted', jsonb_build_object('user_id', p_user, 'note', p_note), me);
  return query select true, 'moderator granted';
end $$;

create or replace function public.admin_revoke_moderator(p_user uuid)
returns table (ok boolean, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not public.app_is_admin(me) then
    return query select false, 'admin only';
    return;
  end if;
  update public.platform_roles
     set revoked_at = now()
   where user_id = p_user and revoked_at is null;
  if not found then
    return query select false, 'no active moderator row';
    return;
  end if;
  perform public.append_audit_log(
    'moderator.revoked', jsonb_build_object('user_id', p_user), me);
  return query select true, 'moderator revoked';
end $$;

-- ---------------------------------------------------------------------------
-- Staff: abuse-report review (admin OR active moderator; audited).
-- ---------------------------------------------------------------------------
create or replace function public.mod_review_abuse_report(
  p_report uuid,
  p_decision text,          -- 'reviewing' | 'actioned' | 'dismissed'
  p_resolution_note text
)
returns table (ok boolean, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not public.app_is_staff(me) then
    return query select false, 'staff only';
    return;
  end if;
  if p_decision not in ('reviewing','actioned','dismissed') then
    return query select false, 'decision must be reviewing|actioned|dismissed';
    return;
  end if;
  if p_decision in ('actioned','dismissed') and coalesce(p_resolution_note, '') = '' then
    return query select false, 'resolution note required to close a report';
    return;
  end if;
  update public.abuse_reports
     set status = p_decision,
         handled_by = me,
         handled_at = now(),
         resolution_note = p_resolution_note,
         updated_at = now()
   where id = p_report;
  if not found then
    return query select false, 'report not found';
    return;
  end if;
  perform public.append_audit_log(
    'abuse.report_reviewed',
    jsonb_build_object('report_id', p_report, 'decision', p_decision), me);
  return query select true, 'review recorded';
end $$;

-- ---------------------------------------------------------------------------
-- Staff: blood-request moderation. 'flag' moves a request to the existing
-- 'flagged' status (then the Phase 6/7 machinery stops outreach, exactly as
-- for cancelled requests). 'clear' returns an flagged request to 'searching'.
-- 'cancel' terminates it. All audited as request.moderation.
-- ---------------------------------------------------------------------------
create or replace function public.mod_review_request(
  p_request uuid,
  p_action  text,           -- 'flag' | 'clear' | 'cancel'
  p_note    text
)
returns table (ok boolean, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  req public.blood_requests%rowtype;
  v_new public.request_status;
begin
  if me is null or not public.app_is_staff(me) then
    return query select false, 'staff only';
    return;
  end if;
  if p_action not in ('flag','clear','cancel') then
    return query select false, 'action must be flag|clear|cancel';
    return;
  end if;
  if coalesce(p_note, '') = '' then
    return query select false, 'a moderation note is required (basis for the decision)';
    return;
  end if;

  select * into req from public.blood_requests where id = p_request;
  if not found then
    return query select false, 'request not found';
    return;
  end if;

  if req.status in ('fulfilled','cancelled','expired','flagged') and p_action <> 'clear' then
    return query select false, 'request already in terminal status ' || req.status::text;
    return;
  end if;

  case p_action
    when 'flag'   then v_new := 'flagged';
    when 'clear'  then v_new := 'searching';
    else               v_new := 'cancelled';
  end case;

  update public.blood_requests
     set status = v_new,
         resolved_at = case when v_new = 'cancelled' then now() else req.resolved_at end
   where id = req.id;

  insert into public.request_transitions (request_id, from_status, to_status, reason, actor_id)
  values (req.id, req.status, v_new, 'moderation: ' || coalesce(p_note,''), me);

  perform public.append_audit_log(
    'request.moderation',
    jsonb_build_object('request_id', req.id, 'from', req.status, 'to', v_new, 'action', p_action), me);
  return query select true, 'request moderated to ' || v_new::text;
end $$;

-- ---------------------------------------------------------------------------
-- Staff: disable a compromised/abusive account (admin or moderator). Staff
-- accounts themselves can NEVER be disabled this way. Audited with ids only.
-- ---------------------------------------------------------------------------
create or replace function public.mod_disable_account(
  p_user  uuid,
  p_reason text
)
returns table (ok boolean, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not public.app_is_staff(me) then
    return query select false, 'staff only';
    return;
  end if;
  if p_user = me then
    return query select false, 'cannot disable your own staff account';
    return;
  end if;
  if coalesce(p_reason, '') = '' then
    return query select false, 'a reason is required';
    return;
  end if;
  if public.app_is_admin(p_user) or public.app_is_moderator(p_user) then
    return query select false, 'staff accounts are protected from this flow';
    return;
  end if;
  insert into public.account_status (user_id, status, disabled_by, disabled_at, reason)
  values (p_user, 'disabled', me, now(), p_reason)
  on conflict (user_id) do update
    set status = 'disabled', disabled_by = me, disabled_at = now(),
        reason = p_reason, resolved_at = null;
  perform public.append_audit_log(
    'account.disabled', jsonb_build_object('user_id', p_user), me);
  return query select true, 'account disabled pending review';
end $$;

-- ---------------------------------------------------------------------------
-- User: request review of their own disabled account (self-service appeal).
-- ---------------------------------------------------------------------------
create or replace function public.account_request_review()
returns table (ok boolean, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    return query select false, 'sign-in required';
    return;
  end if;
  update public.account_status
     set review_requested_at = now(), updated_at = now()
   where user_id = me and status <> 'active' and review_requested_at is null;
  if not found then
    return query select false, 'no disabled account awaiting review (or review already requested)';
    return;
  end if;
  perform public.append_audit_log(
    'account.review_requested', jsonb_build_object('user_id', me), me);
  return query select true, 'review requested; an admin will confirm or reinstate';
end $$;

-- ---------------------------------------------------------------------------
-- ADMIN ONLY: the review decision. Reinstate -> account is fully active
-- again; confirm -> stays disabled (recorded decision + closing note).
-- ---------------------------------------------------------------------------
create or replace function public.admin_review_disabled_account(
  p_user uuid,
  p_decision text,          -- 'reinstate' | 'confirm'
  p_note text
)
returns table (ok boolean, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not public.app_is_admin(me) then
    return query select false, 'admin only (moderators cannot review their own disable decisions)';
    return;
  end if;
  if p_decision not in ('reinstate','confirm') then
    return query select false, 'decision must be reinstate|confirm';
    return;
  end if;
  if coalesce(p_note, '') = '' then
    return query select false, 'review note required';
    return;
  end if;
  if p_decision = 'reinstate' then
    update public.account_status
       set status = 'active', review_by = me, review_note = p_note,
           resolved_at = now(), updated_at = now()
     where user_id = p_user;
  else
    update public.account_status
       set review_by = me, review_note = p_note, updated_at = now()
     where user_id = p_user;
  end if;
  if not found then
    return query select false, 'no account_status row for that user';
    return;
  end if;
  perform public.append_audit_log(
    'account.review_decided',
    jsonb_build_object('user_id', p_user, 'decision', p_decision), me);
  return query select true, 'review recorded (' || p_decision || ')';
end $$;

-- ---------------------------------------------------------------------------
-- ADMIN ONLY: non-clinical platform settings. Unknown keys can still be
-- created but ONLY with an allowed (non-clinical) category — the table's own
-- category CHECK constraint refuses anything clinical.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_setting(
  p_key      text,
  p_value    jsonb,
  p_category text default 'operational',
  p_note     text default null
)
returns table (ok boolean, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  v_existing text;
begin
  if me is null or not public.app_is_admin(me) then
    return query select false, 'admin only';
    return;
  end if;
  if p_value is null or jsonb_typeof(p_value) not in ('number','string','boolean') then
    return query select false, 'value must be a scalar';
    return;
  end if;
  select category into v_existing from public.platform_settings where key = p_key;
  if v_existing is not null and p_category <> v_existing then
    return query select false, 'category of an existing key cannot change (existing: ' || v_existing || ')';
    return;
  end if;
  begin
    insert into public.platform_settings (key, value, category, updated_by)
    values (p_key, p_value, p_category, me)
    on conflict (key) do update
      set value = p_value, updated_by = me, updated_at = now();
  exception when check_violation then
    return query select false, 'category refused (clinical settings are not configurable here)';
    return;
  end;
  perform public.append_audit_log(
    'admin.settings_changed',
    jsonb_build_object('key', p_key, 'value', p_value, 'note', p_note), me);
  return query select true, 'setting recorded';
end $$;

revoke execute on function public.admin_set_setting(text, jsonb, text, text) from anon, authenticated;
grant execute on function public.admin_set_setting(text, jsonb, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Staff inspection: duplicate/misleading profile review. Returns the SAFE
-- display subset plus FRAUD SIGNALS — never a phone number or contact data.
-- 'matches_other_verified_phone' correlates a duplicate acccount WITHOUT
-- exposing the number itself.
-- ---------------------------------------------------------------------------
create or replace function public.mod_inspect_profile(p_user uuid)
returns table (
  ok boolean, message text,
  display_name text, blood_group text, birth_year int,
  is_donor boolean, is_requester boolean,
  availability text, is_phone_verified boolean,
  matches_other_verified_phone boolean,
  open_reports int, created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  v_donor public.donor_profiles%rowtype;
  v_dupes int;
  v_open int;
begin
  if me is null or not public.app_is_staff(me) then
    return query select false, 'staff only', null::text,null::text,null::int,null::boolean,null::boolean,null::text,null::boolean,null::boolean,null::int,null::timestamptz;
    return;
  end if;
  select * into v_donor from public.donor_profiles where user_id = p_user;
  if not found then
    return query select false, 'no donor profile for that user', null::text,null::text,null::int,null::boolean,null::boolean,null::text,null::boolean,null::boolean,null::int,null::timestamptz;
    return;
  end if;

  select count(*) into v_dupes
    from public.contact_numbers cn1
    join public.contact_numbers cn2
      on cn1.phone_normalized = cn2.phone_normalized
     and cn1.user_id <> cn2.user_id
    where cn1.user_id = p_user
      and cn1.verified_at is not null
      and cn2.verified_at is not null;

  select count(*) into v_open
    from public.abuse_reports r
    where r.target_id = p_user and r.status in ('open','reviewing');

  return query select
    true, 'ok',
    (select p.display_name from public.profiles p where p.id = p_user),
    v_donor.blood_group::text,
    v_donor.birth_year::int,
    v_donor.user_id is not null,
    exists (select 1 from public.requester_profiles rq where rq.user_id = p_user),
    v_donor.availability::text,
    v_donor.is_phone_verified,
    v_dupes > 0,
    v_open,
    v_donor.created_at;
end $$;

-- ---------------------------------------------------------------------------
-- EXISTING FUNCTION UPGRADES — Phase 6 coordination flows gain Phase 10
-- gates. The bodies are the Phase 6 originals (0006) with THREE additions,
-- clearly marked: (1) disabled-account denial, (2) acceptance-bypass counter,
-- (3) contact-reveal daily cap. Everything else is unchanged.
-- ---------------------------------------------------------------------------

-- donor_respond_match: deny disabled donor; count forbidden/not-found
-- attempts as acceptance-bypass signals. Follows the 0008 single-row OUT-
-- param signature (the live function since Phase 6's fix); gates are the
-- Phase 10 additions.
drop function if exists public.donor_respond_match(uuid, text, uuid, text);

create or replace function public.donor_respond_match(
  p_match_id uuid,
  p_action   text,
  p_donor    uuid,
  p_source   text default 'in_app',
  out ok        boolean,
  out status    public.match_status,
  out message   text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.request_matches%rowtype;
  r public.blood_requests%rowtype;
  accepted_count integer;
begin
  select * into m from public.request_matches where id = p_match_id for update;
  if not found then
    -- PHASE 10: repeated attempts on random/foreign matches are an abuse
    -- signal (counter + audited on cap inside bump; refusal text unchanged).
    perform public.bump_abuse_counter(p_donor, 'accept_bypass_refusal');
    ok := false; status := null; message := 'match not found'; return;
  end if;
  if m.donor_id <> p_donor then
    -- PHASE 10: unauthorized attempts are counted; refusal text unchanged.
    perform public.bump_abuse_counter(p_donor, 'accept_bypass_refusal');
    ok := false; status := null; message := 'not your match'; return;
  end if;

  -- PHASE 10: a non-active (disabled/suspended) account cannot act on
  -- matches at all (DB-side — a direct PostgREST call cannot bypass this).
  if exists (select 1 from public.account_status s where s.user_id = p_donor and s.status <> 'active') then
    ok := false; status := null; message := 'account disabled'; return;
  end if;

  select * into r from public.blood_requests where id = m.request_id;
  if r.status in ('cancelled', 'expired', 'flagged', 'fulfilled') then
    update public.request_matches
       set status = 'cancelled_with_request', updated_at = now()
     where id = m.id;
    ok := false; status := 'cancelled_with_request';
    message := 'request is ' || r.status::text; return;
  end if;
  if r.status = 'draft' then
    ok := false; status := null; message := 'request not open for response'; return;
  end if;
  if m.expires_at < now() then
    update public.request_matches set status='expired', updated_at=now() where id = m.id;
    ok := false; status := 'expired'; message := 'match expired'; return;
  end if;
  if m.status not in ('pending','notified') then
    ok := false; status := m.status; message := 'already responded'; return;
  end if;

  if p_action = 'accept' then
    select count(*)::int into accepted_count
      from public.request_matches rm
     where rm.request_id = m.request_id and rm.status = 'accepted';
    if accepted_count >= r.units_needed then
      update public.request_matches
         set status = 'unavailable', updated_at = now()
       where id = m.id and request_matches.status in ('pending','notified');
      ok := false; status := 'unavailable';
      message := 'enough donors accepted already'; return;
    end if;
    update public.request_matches
       set status='accepted', accepted_at=now(), responded_at=now(),
           response_source=p_source, updated_at=now()
     where id = m.id;
    perform public.append_audit_log('match.accept',
      jsonb_build_object('match_id', m.id, 'request_id', m.request_id), p_donor);
    ok := true; status := 'accepted'; message := null; return;

  elsif p_action = 'decline' then
    update public.request_matches
       set status='declined', declined_at=now(), responded_at=now(),
           response_source=p_source, updated_at=now()
     where id = m.id;
    perform public.append_audit_log('match.decline',
      jsonb_build_object('match_id', m.id, 'request_id', m.request_id), p_donor);
    ok := true; status := 'declined'; message := null; return;

  elsif p_action = 'unavailable' then
    update public.request_matches
       set status='unavailable', responded_at=now(),
           response_source=p_source, updated_at=now()
     where id = m.id;
    perform public.append_audit_log('match.unavailable',
      jsonb_build_object('match_id', m.id, 'request_id', m.request_id), p_donor);
    ok := true; status := 'unavailable'; message := null; return;

  else
    ok := false; status := null; message := 'unknown action'; return;
  end if;
end;
$$;

-- reveal_contact: deny disabled requester; per-requester daily cap computed
-- from the NON-CLINICAL settings table (fail-closed on a missing cap).
create or replace function public.reveal_contact(
  p_request_id uuid,
  p_donor_id   uuid,
  p_requester  uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.request_matches%rowtype;
  r public.blood_requests%rowtype;
  ph text;
  v_allowed boolean;
  v_count int;
begin
  select * into m from public.request_matches
    where request_id = p_request_id and donor_id = p_donor_id;
  if not found then
    raise exception 'no such match';
  end if;

  select * into r from public.blood_requests where id = p_request_id for update;
  if r.creator_id <> p_requester then
    raise exception 'only the request creator may reveal contact';
  end if;
  if r.status = 'cancelled' then
    raise exception 'request cancelled';
  end if;
  if m.status <> 'accepted' or m.accepted_at is null then
    raise exception 'match not accepted';
  end if;
  if m.expires_at < now() then
    raise exception 'match expired';
  end if;

  -- PHASE 10: a disabled/non-active account cannot pull any contact data.
  if exists (select 1 from public.account_status s
              where s.user_id = p_requester and s.status <> 'active') then
    raise exception 'account disabled';
  end if;

  -- PHASE 10: server-side daily cap for contact reveals (enumeration guard),
  -- computed from the non-clinical settings table.
  select allowed, cnt into v_allowed, v_count
    from public.bump_abuse_counter(p_requester, 'contact_reveal') as bx;
  if v_allowed is not true then
    raise exception 'contact reveal rate limit reached for today';
  end if;

  select verified_phone_of into ph from (select
    (select phone_normalized from public.contact_numbers
      where user_id = p_donor_id and verified_at is not null) as verified_phone_of) s;
  if ph is null then
    raise exception 'donor phone not verified';
  end if;

  insert into public.contact_reveals (match_id, requester_id, donor_id)
  values (m.id, p_requester, p_donor_id);
  perform public.append_audit_log('contact.revealed',
    jsonb_build_object('request_id', p_request_id, 'donor_id', p_donor_id), p_requester);
  return ph;
end;
$$;

-- ---------------------------------------------------------------------------
-- Disabled-account enforcement at the DB layer for direct write paths:
-- the blood_requests insert/update policies now refuse any non-active
-- account, so a suspended user cannot bypass the app by calling PostgREST
-- with their own session. Same policy names, strictly more restrictive.
-- ---------------------------------------------------------------------------
drop policy if exists blood_requests_insert_owner on public.blood_requests;
create policy blood_requests_insert_owner on public.blood_requests
  for insert to authenticated
  with check (
    creator_id = auth.uid()
    and status in ('draft', 'submitted')
    and not exists (
      select 1 from public.account_status s
       where s.user_id = auth.uid() and s.status <> 'active'
    )
  );

drop policy if exists blood_requests_update_owner_active on public.blood_requests;
create policy blood_requests_update_owner_active on public.blood_requests
  for update to authenticated
  using (
    creator_id = auth.uid()
    and not exists (
      select 1 from public.account_status s
       where s.user_id = auth.uid() and s.status <> 'active'
    )
  )
  with check (
    creator_id = auth.uid()
    and status in ('draft', 'submitted', 'searching', 'awaiting_responses')
    and not exists (
      select 1 from public.account_status s
       where s.user_id = auth.uid() and s.status <> 'active'
    )
  );

-- ---------------------------------------------------------------------------
-- QUARANTINE FIX (caught by the migration verifier during this phase):
-- Phase 8 (0011) created donation_records / recovery_rules /
-- donor_recovery_holds WITH policies but never enabled RLS on those tables.
-- RLS policies are inert while relrowsecurity = false, so the policy-based
-- "own rows or admin" promises were not actually enforced. Enable RLS now —
-- the existing policies (unchanged from 0011) become active.
-- ---------------------------------------------------------------------------
alter table public.donation_records enable row level security;
alter table public.recovery_rules enable row level security;
alter table public.donor_recovery_holds enable row level security;

-- ---------------------------------------------------------------------------
-- Grants: staffed RPCs are callable by authenticated sessions; the functions
-- themselves re-verify roles server-side, so granting execute is delegation
-- of the CALL, never of the AUTHORITY.
-- ---------------------------------------------------------------------------
grant execute on function public.app_is_admin(uuid)      to authenticated, service_role;
grant execute on function public.app_is_moderator(uuid)  to authenticated, service_role;
grant execute on function public.app_is_staff(uuid)      to authenticated, service_role;
grant execute on function public.admin_grant_moderator(uuid, text) to authenticated, service_role;
grant execute on function public.admin_revoke_moderator(uuid)      to authenticated, service_role;
grant execute on function public.mod_review_abuse_report(uuid, text, text) to authenticated, service_role;
grant execute on function public.mod_review_request(uuid, text, text)      to authenticated, service_role;
grant execute on function public.mod_disable_account(uuid, text)           to authenticated, service_role;
grant execute on function public.account_request_review()                  to authenticated, service_role;
grant execute on function public.admin_review_disabled_account(uuid, text, text) to authenticated, service_role;
grant execute on function public.mod_inspect_profile(uuid) to authenticated, service_role;

commit;

