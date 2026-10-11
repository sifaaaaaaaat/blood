-- ============================================================================
-- Migration 0003: Phase 4 — Blood Request Management
--
-- Scope:
--   * request status state machine (enum) + transition history table
--   * blood_requests with minimal coordination-only fields
--   * idempotency: per-requester unique client-generated key
--   * RLS: owner-scoped writes, explicit authorization boundaries
--   * audit events on state transitions via append_audit_log
--
-- Privacy: NO patient names, NO national ID, NO medical history.
-- Requester confirms they have consent/permission to submit what they enter.
-- ============================================================================

begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'request_status' and typnamespace = 'public'::regnamespace) then
    create type public.request_status as enum (
      'draft', 'submitted', 'searching', 'awaiting_responses',
      'connected', 'fulfilled', 'cancelled', 'expired', 'flagged'
    );
  end if;
end $$;

create table if not exists public.blood_requests (
  id               uuid primary key default gen_random_uuid(),
  creator_id       uuid not null references public.profiles (id) on delete cascade,
  blood_group      public.blood_group not null,
  location_id      integer not null references public.upazilas (id) on delete restrict,
  location_text    text not null check (char_length(location_text) <= 240),
  urgency          public.request_urgency not null default 'routine',
  units_needed     smallint not null check (units_needed between 1 and 20),
  required_by      timestamptz not null,
  request_notes    text check (char_length(request_notes) <= 500),
  -- Requester confirms they have permission to submit the info they entered
  consent_confirmed boolean not null default false,
  -- Contact preferences: what a donor sees after accepting (Phase 7 reveal)
  contact_pref     text not null default 'in_app'
                   check (contact_pref in ('in_app', 'sms', 'phone_call')),
  status           public.request_status not null default 'draft',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  resolved_at      timestamptz,           -- set on fulfilled/cancelled/expired
  -- Idempotency: same creator + same key = same request; dedupe on retry
  idempotency_key  text not null,
  unique (creator_id, idempotency_key)
);

create index if not exists blood_requests_status_idx on public.blood_requests (status, required_by);
create index if not exists blood_requests_creator_idx on public.blood_requests (creator_id, created_at desc);

-- Every state change recorded as its own row — full, auditable transition trail.
create table if not exists public.request_transitions (
  id           bigint generated always as identity primary key,
  request_id   uuid not null references public.blood_requests (id) on delete cascade,
  from_status  public.request_status,
  to_status    public.request_status not null,
  reason       text check (char_length(reason) <= 300),
  actor_id     uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists request_transitions_request_idx
  on public.request_transitions (request_id, created_at);

alter table public.blood_requests       enable row level security;
alter table public.request_transitions  enable row level security;

-- --------------------------------------------------------------------------
-- blood_requests: any authenticated user can read (needed for matching later);
-- only the creator may write, and only while the request is still mutable.
-- --------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='blood_requests' and policyname='blood_requests_select_authenticated') then
    create policy blood_requests_select_authenticated on public.blood_requests
      for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='blood_requests' and policyname='blood_requests_insert_owner') then
    create policy blood_requests_insert_owner on public.blood_requests
      for insert to authenticated
      with check (creator_id = auth.uid() and status in ('draft', 'submitted'));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='blood_requests' and policyname='blood_requests_update_owner_active') then
    create policy blood_requests_update_owner_active on public.blood_requests
      for update to authenticated
      using (creator_id = auth.uid())
      with check (creator_id = auth.uid() and status in ('draft', 'submitted', 'searching', 'awaiting_responses'));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='blood_requests' and policyname='blood_requests_delete_owner_draft') then
    create policy blood_requests_delete_owner_draft on public.blood_requests
      for delete to authenticated
      using (creator_id = auth.uid() and status = 'draft');
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='request_transitions' and policyname='request_transitions_select_authenticated') then
    create policy request_transitions_select_authenticated on public.request_transitions
      for select to authenticated using (true);
  end if;
end $$;

-- ----------
-- transitions are written by the service using the actor's own identity;
-- no client-side INSERT is allowed directly (the service SECURITY DEFINER
-- function below is the only writer).
-- ----------
create or replace function public.record_transition(
  p_request_id uuid,
  p_from       public.request_status,
  p_to         public.request_status,
  p_reason     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_request_id is null then
    raise exception 'record_transition: request_id required';
  end if;
  -- Only the request creator (or an admin) may record transitions.
  if not exists (
    select 1 from public.blood_requests r
    where r.id = p_request_id
      and (r.creator_id = auth.uid()
           or exists (select 1 from public.profiles p
                      where p.id = auth.uid() and p.is_admin))
  ) then
    raise exception 'record_transition: not authorized for request %', p_request_id;
  end if;

  insert into public.request_transitions (request_id, from_status, to_status, reason, actor_id)
  values (p_request_id, p_from, p_to, p_reason, auth.uid());

  perform public.append_audit_log(
    'request.transition',
    jsonb_build_object('request_id', p_request_id, 'from', p_from, 'to', p_to, 'reason', p_reason),
    auth.uid()
  );
end;
$$;

-- Service uses SECURITY DEFINER to write history even when the table itself is
-- not directly writable by clients. Explicitly revoke direct DML.
revoke insert, update, delete on public.request_transitions from anon, authenticated;
revoke update on public.blood_requests from anon;

grant insert, select, update on public.blood_requests to authenticated;
grant select on public.request_transitions to authenticated;

-- ----------
-- Expiry helper: server jobs (Phase 8+) mark stale open requests expired.
-- Kept here so the state machine owns all transitions, not ad-hoc SQL.
-- ----------
create or replace function public.expire_stale_requests()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  moved integer := 0;
begin
  with stale as (
    update public.blood_requests
       set status = 'expired', resolved_at = now()
     where status in ('submitted', 'searching', 'awaiting_responses')
       and required_by < now()
    returning id
  )
  select count(*) into moved from stale;

  if moved > 0 then
    insert into public.request_transitions (request_id, from_status, to_status, reason)
    select id, null::public.request_status, 'expired', 'required_by passed'
      from public.blood_requests
     where status = 'expired'
       and resolved_at >= now() - interval '1 second';
    perform public.append_audit_log('request.expire_batch',
      jsonb_build_object('count', moved));
  end if;
  return moved;
end;
$$;

revoke execute on function public.expire_stale_requests() from anon, authenticated;

-- updated_at trigger
do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'blood_requests_touch' and tgrelid = 'public.blood_requests'::regclass
  ) then
    create trigger blood_requests_touch before update on public.blood_requests
      for each row execute function public.touch_updated_at();
  end if;
end $$;

commit;
