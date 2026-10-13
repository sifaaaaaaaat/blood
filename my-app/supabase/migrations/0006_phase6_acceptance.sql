-- ============================================================================
-- Migration 0006: Phase 6 — Donor Acceptance and Contact Sharing
--
-- Data model:
--   request_matches  — one row per (request, donor); matching status,
--                      notification state, timestamps, audit metadata
--   match_action_tokens — hashed, single-use, short-lived action tokens
--   contact_reveals  — append-only audit of each contact-disclosure event
--
-- Authz summary (also documented in the phase report):
--   · donor writes own match rows only (RLS + service double-check)
--   · requester reads matches for own requests only
--   · phone NEVER lives in any table a non-owner can SELECT; contact reveal
--     happens in a SECURITY DEFINER function that rechecks state each time
--   · one accept per (request) once desired_units filled; simultaneous
--     accepts serialize through row-level locking in the accept function
-- ============================================================================

begin;

do $$
begin
  if not exists (select 1 from pg_type where typname='match_status' and typnamespace='public'::regnamespace) then
    create type public.match_status as enum (
      'pending', 'notified', 'accepted', 'declined',
      'unavailable', 'expired', 'cancelled_with_request'
    );
  end if;
end $$;

create table if not exists public.request_matches (
  id                uuid primary key default gen_random_uuid(),
  request_id        uuid not null references public.blood_requests (id) on delete cascade,
  donor_id          uuid not null references public.profiles (id) on delete cascade,
  status            public.match_status not null default 'pending',
  notify_state      text not null default 'none'
                    check (notify_state in ('none','queued','sent','failed','skipped')),
  notify_attempt_at timestamptz,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default now() + interval '24 hours',
  responded_at      timestamptz,
  accepted_at       timestamptz,
  declined_at       timestamptz,
  -- audit metadata
  response_source   text check (response_source in ('in_app','action_token')),
  created_by        text not null default 'matching_engine',
  updated_at        timestamptz not null default now(),
  unique (request_id, donor_id)
);

create index if not exists request_matches_donor_idx on public.request_matches (donor_id, status);
create index if not exists request_matches_request_idx on public.request_matches (request_id, status);

-- Single-use, short-lived action tokens: store SHA-256 hash only.
create table if not exists public.match_action_tokens (
  token_hash  text primary key,
  match_id    uuid not null references public.request_matches (id) on delete cascade,
  action      text not null check (action in ('accept','decline','unavailable')),
  expires_at  timestamptz not null default now() + interval '30 minutes',
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

alter table public.request_matches    enable row level security;
alter table public.match_action_tokens enable row level security;

-- append-only audit of contact disclosures
create table if not exists public.contact_reveals (
  id          bigint generated always as identity primary key,
  match_id    uuid not null references public.request_matches (id) on delete cascade,
  requester_id uuid not null references public.profiles (id) on delete cascade,
  donor_id    uuid not null references public.profiles (id) on delete cascade,
  revealed_at timestamptz not null default now(),
  channel     text not null default 'in_app'
);

alter table public.contact_reveals enable row level security;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- matches: donor sees own rows; requester sees rows for own requests; admins all.
do $$
begin
if not exists (select 1 from pg_policies where tablename='request_matches' and policyname='request_matches_donor_rw') then
  create policy request_matches_donor_rw on public.request_matches
    for all to authenticated
    using (donor_id = auth.uid())
    with check (donor_id = auth.uid());
end if;
if not exists (select 1 from pg_policies where tablename='request_matches' and policyname='request_matches_requester_select') then
  create policy request_matches_requester_select on public.request_matches
    for select to authenticated
    using (
      exists (
        select 1 from public.blood_requests r
        where r.id = request_matches.request_id
          and r.creator_id = auth.uid()
      )
    );
end if;
if not exists (select 1 from pg_policies where tablename='request_matches' and policyname='request_matches_admin_all') then
  create policy request_matches_admin_all on public.request_matches
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- tokens: no direct client access at all (service-role only)
-- (no policy => deny all)

-- contact_reveals: donor + requester parties can view own events; admins all.
    create policy request_matches_admin_all on public.request_matches
      for all to authenticated
      using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
      with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
end if;
if not exists (select 1 from pg_policies where tablename='contact_reveals' and policyname='contact_reveals_select_party') then
  create policy contact_reveals_select_party on public.contact_reveals
    for select to authenticated
    using (requester_id = auth.uid() or donor_id = auth.uid()
           or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
end if;
end $$;

-- ---------------------------------------------------------------------------
-- Atomic coordination — the ONLY place statuses change together.
-- ---------------------------------------------------------------------------
create or replace function public.donor_respond_match(
  p_match_id uuid,
  p_action   text,
  p_donor    uuid,
  p_source   text default 'in_app'
)
returns table (ok boolean, new_status public.match_status, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  m  public.request_matches%rowtype;
  r  public.blood_requests%rowtype;
begin
  -- ownership: donor must own this exact match
  select * into m from public.request_matches where id = p_match_id for update;
  if not found then
    return query select false, null::public.match_status, 'match not found';
  end if;
  if m.donor_id <> p_donor then
    return query select false, null::public.match_status, 'not your match';
  end if;

  select * into r from public.blood_requests where id = m.request_id;
  -- cancelled/expired/flagged requests stop coordination entirely
  if r.status in ('cancelled', 'expired', 'flagged', 'fulfilled') then
    update public.request_matches
       set status = 'cancelled_with_request', updated_at = now()
     where id = m.id;
    return query select false, 'cancelled_with_request'::public.match_status,
                        'request is ' || r.status::text;
  end if;
  if r.status = 'draft' then
    return query select false, null::public.match_status, 'request not open for response';
  end if;
  if m.expires_at < now() then
    update public.request_matches set status='expired', updated_at=now() where id = m.id;
    return query select false, 'expired'::public.match_status, 'match expired';
  end if;
  if m.status not in ('pending','notified') then
    return query select false, m.status, 'already responded';
  end if;

  if p_action = 'accept' then
    -- simultaneous accepts serialize via the FOR UPDATE row lock above;
    -- check current accepted count inside the lock to avoid over-accepting.
    if (select count(*) from public.request_matches
        where request_id = m.request_id and status = 'accepted')
       >= r.units_needed then
      update public.request_matches
         set status = 'unavailable', updated_at = now()
       where id = m.id and status in ('pending','notified');
      return query select false, 'unavailable'::public.match_status,
                          'enough donors accepted already';
    end if;
    update public.request_matches
       set status='accepted', accepted_at=now(), responded_at=now(),
           response_source=p_source, updated_at=now()
     where id = m.id;
    perform public.append_audit_log('match.accept',
      jsonb_build_object('match_id', m.id, 'request_id', m.request_id), p_donor);
    return query select true, 'accepted'::public.match_status, null::text;

  elsif p_action = 'decline' then
    update public.request_matches
       set status='declined', declined_at=now(), responded_at=now(),
           response_source=p_source, updated_at=now()
     where id = m.id;
    perform public.append_audit_log('match.decline',
      jsonb_build_object('match_id', m.id, 'request_id', m.request_id), p_donor);
    return query select true, 'declined'::public.match_status, null::text;

  elsif p_action = 'unavailable' then
    update public.request_matches
       set status='unavailable', responded_at=now(),
           response_source=p_source, updated_at=now()
     where id = m.id;
    perform public.append_audit_log('match.unavailable',
      jsonb_build_object('match_id', m.id, 'request_id', m.request_id), p_donor);
    return query select true, 'unavailable'::public.match_status, null::text;

  else
    return query select false, null::public.match_status, 'unknown action';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Contact disclosure — rechecks state and authorization on EVERY call.
-- Phone numbers live in contact_numbers; requester must be the request
-- creator, match must be accepted, and every reveal is audit-logged.
-- ---------------------------------------------------------------------------
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
begin
  select * into m from public.request_matches
    where request_id = p_request_id and donor_id = p_donor_id;
  if not found then
    raise exception 'no such match';     -- guessing IDs yields no data
  end if;

  select * into r from public.blood_requests where id = p_request_id for update;
  if r.creator_id <> p_requester then
    raise exception 'only the request creator may reveal contact';
  end if;
  if r.status = 'cancelled' then
    raise exception 'request cancelled'; -- no reveal after cancellation
  end if;
  if m.status <> 'accepted' or m.accepted_at is null then
    raise exception 'match not accepted';
  end if;
  if m.expires_at < now() then
    raise exception 'match expired';
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

revoke execute on function public.reveal_contact(uuid, uuid, uuid) from anon, authenticated;
revoke execute on function public.donor_respond_match(uuid, text, uuid, text) from anon, authenticated;

do $$
begin
if not exists (select 1 from pg_trigger where tgname='request_matches_touch' and tgrelid='public.request_matches'::regclass) then
  create trigger request_matches_touch before update on public.request_matches
    for each row execute function public.touch_updated_at();
end if;
end $$;

commit;
