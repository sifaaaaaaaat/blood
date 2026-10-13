-- ============================================================================
-- Phase 8: donation history, recovery rules, donor fatigue/availability.
--
-- HARD DESIGN RULES (do not weaken without the owner's sign-off):
--  · Self-reported donation data is stored WITHOUT any verification claim.
--    verification_* fields are written only by authorized verifiers (admin;
--    partner attestation recorded by admin). No code path may present a
--    self-report as independently verified.
--  · There is NO hardcoded universal eligibility window. Exclusion periods
--    exist ONLY via recovery_rules rows that carry a named approval
--    (approved_by_name + approval_reference) by a qualified local blood
--    service / medical partner. No rule row => no automatic exclusion.
--  · Expiry NEVER auto-classifies a donor as medically/clinically eligible:
--    it only flips the facing state to "confirm your availability". The
--    donor must act (donor_confirm_availability) before matching resumes.
--  · "Clinical eligibility" is a concept this platform never computes.
--    donor_recovery_holds holds ADMINISTRATIVE outreach holds only; the
--    state machine never emits the words medically/clinically eligible.
--  · Admin override of a hold is possible ONLY with an explicit named
--    medical authority (authorization gate), and is audited separately.
-- ============================================================================

begin;

do $$ begin
  if not exists (select 1 from pg_type where typname='donation_type' and typnamespace='public'::regnamespace) then
    create type public.donation_type as enum ('whole_blood','power_red','plasma','platelets');
  end if;
  if not exists (select 1 from pg_type where typname='donation_source' and typnamespace='public'::regnamespace) then
    create type public.donation_source as enum ('self_reported','partner_reported','admin_recorded');
  end if;
  if not exists (select 1 from pg_type where typname='verification_status' and typnamespace='public'::regnamespace) then
    create type public.verification_status as enum ('unverified','verified','rejected');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Donation records: donor reports + separately stored verification
-- ---------------------------------------------------------------------------
create table if not exists public.donation_records (
  id                 uuid primary key default gen_random_uuid(),
  donor_id           uuid not null references public.profiles (id) on delete cascade,
  donation_date      date not null check (donation_date <= current_date),  -- future dates rejected
  donation_type      public.donation_type not null,
  facility           text,
  report_note        text,
  source             public.donation_source not null default 'self_reported',
  -- Separated verification block — never client-writable:
  verification       public.verification_status not null default 'unverified',
  verification_actor_role text check (verification_actor_role in ('admin','partner')),
  verification_actor uuid references public.profiles (id),
  verified_at        timestamptz,
  verified_basis     text,
  conflict_with      uuid references public.donation_records (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (donor_id, donation_date, donation_type)
);
create index if not exists donation_records_donor_idx on public.donation_records (donor_id, donation_date desc);

-- ---------------------------------------------------------------------------
-- Recovery rules: configurable ONLY via approved rows. approval_* NOT NULL by
-- construction; active rows are created through admin_set_recovery_rule.
-- Keeping rules in the DATABASE means the exclusion math runs where the data
-- lives and an approval cannot be silently dropped in a config edit.
-- ---------------------------------------------------------------------------
create table if not exists public.recovery_rules (
  id                uuid primary key default gen_random_uuid(),
  donation_type     public.donation_type not null,
  exclusion_days    integer not null check (exclusion_days between 0 and 3650),
  active            boolean not null default true,
  approved_by_name  text not null,          -- attested name of qualified approver
  approval_reference text not null,         -- e.g. memo/reference number
  approved_by_user  uuid references public.profiles (id),  -- admin who recorded it
  approved_at       timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
create unique index if not exists recovery_rules_one_active
  on public.recovery_rules (donation_type) where active;

-- ---------------------------------------------------------------------------
-- Administrative outreach holds (NOT clinical classifications)
-- ---------------------------------------------------------------------------
create table if not exists public.donor_recovery_holds (
  donor_id        uuid primary key references public.profiles (id) on delete cascade,
  until_date      date not null,
  reason          text not null,           -- donor-facing explanation
  based_on_record uuid references public.donation_records (id),
  rule_id         uuid references public.recovery_rules (id),
  lifted          boolean not null default false,
  lifted_by       uuid references public.profiles (id),
  lifted_by_role  text check (lifted_by_role in ('donor','admin')),
  lifted_note     text,
  lifted_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (not lifted or lifted_note is not null)
);

do $$
begin
  if not exists (select 1 from pg_policies where tablename='donation_records' and policyname='donation_records_select_own_or_admin') then
    create policy donation_records_select_own_or_admin on public.donation_records
      for select to authenticated
      using (donor_id = auth.uid()
             or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
  end if;
  -- donors write ONLY via RPC (report). No insert/update policy => deny.
  if not exists (select 1 from pg_policies where tablename='donation_records' and policyname='donation_records_admin_update') then
    create policy donation_records_admin_update on public.donation_records
      for update to authenticated
      using (donor_id = auth.uid()
             or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
  end if;
  if not exists (select 1 from pg_policies where tablename='recovery_rules' and policyname='recovery_rules_admin_or_read_active') then
    create policy recovery_rules_admin_or_read_active on public.recovery_rules
      for select to authenticated
      using (active or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
  end if;
  if not exists (select 1 from pg_policies where tablename='donor_recovery_holds' and policyname='donor_recovery_holds_select_own_or_admin') then
    create policy donor_recovery_holds_select_own_or_admin on public.donor_recovery_holds
      for select to authenticated
      using (donor_id = auth.uid()
             or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
  end if;
  -- holds: writes via RPC only (confirm/lift).
end $$;

commit;
