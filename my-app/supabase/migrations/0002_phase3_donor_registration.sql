-- ============================================================================
-- Migration 0002: Phase 3 — Authentication and Donor Registration
--
-- Scope:
--   * donor profile: notification-preferences columns + explicit consent
--   * contact_numbers: separate verified/normalize/primary states —
--     phone verification NEVER implies blood-group or medical verification
--   * location columns on donor_profiles referencing 0001 lookup tables
--   * seed divisions from the documented BD source
--
-- Truthful auth state (probed live): phone provider disabled on this project;
-- email magic-link chosen for Phase 3. Nothing here assumes working OTP.
-- ============================================================================

begin;

alter table public.donor_profiles
  add column if not exists division_id  smallint references public.divisions (id) on delete restrict,
  add column if not exists district_id  smallint references public.districts (id) on delete restrict,
  add column if not exists notify_consent        boolean    not null default false,
  add column if not exists notify_channel        text       not null default 'in_app'
                  check (notify_channel in ('in_app', 'sms', 'none')),
  add column if not exists notify_last_sent_at   timestamptz;

-- Consolidate location: upazila belongs to its district, district to division.
-- The FK chain to the lookup tables keeps hierarchy relations valid — a donor
-- cannot pick an upazila from a different district.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.donor_profiles'::regclass
      and conname  = 'donor_profiles_upazila_id_fkey'
  ) then
    alter table public.donor_profiles drop constraint donor_profiles_upazila_id_fkey;
  end if;
end $$;

-- Guarded adds (idempotent against already-applied runs).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.donor_profiles'::regclass
      and conname  = 'donor_loc_fk_upazila_in_district'
  ) then
    alter table public.donor_profiles
      add constraint donor_loc_fk_upazila_in_district
        foreign key (upazila_id, district_id)
        references public.upazilas (id, district_id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.donor_profiles'::regclass
      and conname  = 'donor_loc_fk_district_in_division'
  ) then
    alter table public.donor_profiles
      add constraint donor_loc_fk_district_in_division
        foreign key (district_id, division_id)
        references public.districts (id, division_id) on delete restrict;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- contact_numbers — verifiable identity data, one row per auth user in 0001.
-- Phase 3 clarifies its meaning:
--  · phone           — raw input
--  · phone_normalized— E.164 (+880XXXXXXXXXX) after server-side normalization
--  · verified_at     — NULL until a real OTP/link confirm; never set by RLS
--    client paths, only via a server-verified flow
--  · verified_phone unique + owner-only RLS; never joined into any other
--    user's read path (phone never appears in search results)
-- ---------------------------------------------------------------------------
alter table public.contact_numbers
  add column if not exists phone_normalized text
    check (phone_normalized is null or phone_normalized ~ '^\+8801[3-9][0-9]{8}$');

create unique index if not exists contact_numbers_verified_phone_uq
  on public.contact_numbers (phone_normalized)
  where verified_at is not null;

-- Explicit consent ledger for notification channels (no payments, ever).
create table if not exists public.notification_consents (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  channel     text not null check (channel in ('in_app', 'sms')),
  consented_at timestamptz not null default now(),
  revoked_at  timestamptz,
  primary key (user_id, channel, consented_at)
);

alter table public.notification_consents enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'notification_consents'
      and policyname = 'notification_consents_owner_all'
  ) then
    create policy notification_consents_owner_all on public.notification_consents
      for all to authenticated
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'notification_consents_touch'
      and tgrelid  = 'public.notification_consents'::regclass
  ) then
    create trigger notification_consents_touch before update
      on public.notification_consents
      for each row execute function public.touch_updated_at();
  end if;
end $$;

grant select, insert on public.notification_consents to authenticated;
grant update on public.notification_consents to authenticated;

commit;
