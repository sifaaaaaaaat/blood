-- ============================================================================
-- Migration 0001: Phase 2 — Backend Foundation and Database
-- Blood Donor Platform (Bangladesh MVP)
--
-- Scope (Phase 2 ONLY, per master instructions):
--   * core enums
--   * public.profiles (+ donor/requester profile tables)
--   * admin bootstrap scaffolding (controlled SQL op; no public promotion path)
--   * RLS policies (deny-by-default, owner-scoped writes)
--   * audit_log (append-only)
--   * updated_at trigger
--
-- Identity source: Supabase auth.users (phone OTP configured in Phase 3).
-- No eligibility claims, no compatibility matrix, no payment columns.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.blood_group as enum ('A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-');
create type public.donor_availability as enum ('available', 'paused');
create type public.request_urgency as enum ('routine', 'urgent', 'critical');

-- ---------------------------------------------------------------------------
-- Profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 2 and 80),
  is_donor      boolean not null default false,
  is_requester  boolean not null default false,
  is_admin      boolean not null default false,
  referral_code text unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- No free-text location on profiles; administrative hierarchy joins live on
-- the donor profile (Phase 4) via FK — never repeated strings.

-- ---------------------------------------------------------------------------
-- Location lookup tables (seeded from a documented public source — Phase 4;
-- structure created here so donor profiles can reference them with FKs)
-- ---------------------------------------------------------------------------
create table public.divisions (
  id   smallint primary key,
  name text not null unique,        -- e.g. 'Dhaka'
  bn_name text not null
);

create table public.districts (
  id          smallint primary key,
  division_id smallint not null references public.divisions (id) on delete restrict,
  name        text not null unique,
  bn_name     text not null
);

create table public.upazilas (
  id          integer primary key,
  district_id smallint not null references public.districts (id) on delete restrict,
  name        text not null,
  bn_name     text not null
);

-- ---------------------------------------------------------------------------
-- Donor / requester profiles (1:0..1 per declared role)
-- ---------------------------------------------------------------------------
create table public.donor_profiles (
  user_id             uuid primary key references public.profiles (id) on delete cascade,
  blood_group         public.blood_group not null,
  birth_year          smallint not null
                        check (birth_year between date_part('year', now())::smallint - 100
                                              and date_part('year', now())::smallint - 16),
  upazila_id          integer not null references public.upazilas (id) on delete restrict,
  availability        public.donor_availability not null default 'available',
  paused_until        timestamptz,
  last_donation_date  date,
  is_phone_verified   boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (paused_until is null or paused_until > now())
);

-- Phone is stored ONLY here, owner-readable, never joined by another user's
-- SELECT path. Requesters see contact info only via accept-time flows (Phase 7).
create table public.contact_numbers (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  phone       text not null check (phone ~ '^\+8801[3-9][0-9]{8}$'),  -- Bangladeshi mobile
  verified_at timestamptz,             -- NULL until OTP confirmation actually succeeds
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.requester_profiles (
  user_id                uuid primary key references public.profiles (id) on delete cascade,
  org_name               text check (char_length(org_name) <= 120),
  preferred_contact_note text check (char_length(preferred_contact_note) <= 240),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger donor_profiles_touch before update on public.donor_profiles
  for each row execute function public.touch_updated_at();
create trigger contact_numbers_touch before update on public.contact_numbers
  for each row execute function public.touch_updated_at();
create trigger requester_profiles_touch before update on public.requester_profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Auto-provision a profile row whenever an auth user is created (phone signup)
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, is_donor, is_requester, is_admin)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'display_name',
      'User-' || left(new.id::text, 8)
    ),
    false, false, false
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Audit log — append-only; no UPDATE/DELETE grants at all
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id         bigint generated always as identity primary key,
  actor_id   uuid references public.profiles (id) on delete set null,  -- null = system
  action     text not null,           -- machine code, e.g. 'admin_role.grant'
  detail     jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index audit_log_actor_idx on public.audit_log (actor_id, created_at desc);
create index audit_log_action_idx on public.audit_log (action, created_at desc);

create or replace function public.append_audit_log(
  p_action text,
  p_detail jsonb default '{}',
  p_actor  uuid default auth.uid()
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.audit_log (actor_id, action, detail)
  values (p_actor, p_action, p_detail);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin bootstrap — controlled, idempotent, one-time. NOT exposed to clients.
-- Run path (service key / dashboard SQL editor only):
--   select public.admin_bootstrap_grant('AUTH-USER-UUID-HERE');
-- Then verify:   select public.admin_bootstrap_verify('AUTH-USER-UUID-HERE');
-- ---------------------------------------------------------------------------
create or replace function public.admin_bootstrap_grant(p_user uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_is_admin boolean;
begin
  if p_user is null then
    raise exception 'admin_bootstrap_grant: explicit user UUID required';
  end if;

  select is_admin into v_is_admin from public.profiles where id = p_user;
  if v_is_admin is null then
    raise exception 'admin_bootstrap_grant: user % has no profile; run admin signup first', p_user;
  end if;

  insert into public.profiles (id, display_name, is_donor, is_requester, is_admin)
  values (p_user, 'User-' || left(p_user::text, 8), false, false, true)
  on conflict (id) do update
    set is_admin = true;   -- idempotent re-run is safe

  perform public.append_audit_log(
    'admin_role.grant',
    jsonb_build_object('target_user', p_user, 'method', 'admin_bootstrap_grant'),
    p_user
  );
end;
$$;

create or replace function public.admin_bootstrap_verify(p_user uuid)
returns boolean
language sql
security definer set search_path = public
as $$
  select coalesce(is_admin, false) from public.profiles where id = p_user;
$$;

revoke execute on function public.admin_bootstrap_grant(uuid) from anon, authenticated;
revoke execute on function public.admin_bootstrap_verify(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS — enabled on every table; policies are deny-by-default
-- ---------------------------------------------------------------------------
alter table public.profiles           enable row level security;
alter table public.donor_profiles     enable row level security;
alter table public.requester_profiles enable row level security;
alter table public.contact_numbers    enable row level security;
alter table public.divisions          enable row level security;
alter table public.districts          enable row level security;
alter table public.upazilas           enable row level security;
alter table public.audit_log          enable row level security;

-- helper: only row owner may write
create or replace function public.is_owner(col uuid)
returns boolean
language sql
stable
as $$ select col = auth.uid() $$;

-- ---- profiles: every authenticated user may look up basic display info;
-- ---- only the owner may write; admin flag never client-writable.
create policy profiles_select_authenticated on public.profiles
  for select to authenticated
  using (true);

create policy profiles_insert_self on public.profiles
  for insert to authenticated
  with check (id = auth.uid() and is_admin = false);   -- admin flag never client-set

create policy profiles_update_nonadmin_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and is_admin = (select p.is_admin from public.profiles as p where p.id = auth.uid())
    and is_admin = false
  );

-- Prevent opting into roles via anonymous signup path.
create policy profiles_delete_self on public.profiles
  for delete to authenticated
  using (id = auth.uid());

-- ---- donor_profiles: readable to authenticated users (MATCHING uses this
-- ---- surface; phone is intentionally elsewhere). Writable by owner only.
create policy donor_profiles_select_authenticated on public.donor_profiles
  for select to authenticated
  using (true);

create policy donor_profiles_manage_self on public.donor_profiles
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy donor_profiles_admin_manage on public.donor_profiles
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- ---- requester_profiles: SELECTable (matches location search visibility),
-- ---- writable only by owner — never by another user.
create policy requester_profiles_select_authenticated on public.requester_profiles
  for select to authenticated
  using (true);

create policy requester_profiles_manage_self on public.requester_profiles
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---- contact_numbers: STRICTEST policy — owner-only CRUD.
create policy contact_numbers_owner_all on public.contact_numbers
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---- lookup tables: readable by authenticated users only (not anon) to
-- ---- avoid leaking location taxonomy to unauthenticated scrapers.
create policy divisions_select on public.divisions
  for select to authenticated using (true);
create policy districts_select on public.districts
  for select to authenticated using (true);
create policy upazilas_select on public.upazilas
  for select to authenticated using (true);

-- ---- audit_log: readable only by admins; INSERT only via the security
-- ---- definer function; nobody (including admins) can UPDATE or DELETE.
create policy audit_log_select_admin on public.audit_log
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- ---------------------------------------------------------------------------
-- Grants — least privilege
-- ---------------------------------------------------------------------------
revoke all on public.audit_log from anon, authenticated;
grant select  on public.audit_log  to authenticated;   -- RLS will filter to admins
grant insert  on public.profiles, public.donor_profiles, public.requester_profiles,
              public.contact_numbers                 to authenticated;
grant update  on public.profiles, public.donor_profiles, public.requester_profiles,
              public.contact_numbers                 to authenticated;
grant delete  on public.profiles, public.donor_profiles, public.requester_profiles,
              public.contact_numbers                 to authenticated;
grant select  on public.divisions, public.districts, public.upazilas to authenticated;

commit;
