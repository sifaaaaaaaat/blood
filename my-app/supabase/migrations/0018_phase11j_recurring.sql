-- Phase 11J: thalassemia / recurring blood request schedules.
--
-- A schedule itself sends NOTHING. When its due date arrives, the owner (or
-- an admin sweep) can materialize it as a DRAFT blood request — which then
-- follows the exact same consent, validation, matching and contact gates as
-- every other request. The honest workaround for "automation without
-- consent-drift": the platform proposes, the human submits.

create table if not exists public.recurring_requests (
  id              uuid primary key default gen_random_uuid(),
  creator_id      uuid not null references public.profiles (id) on delete cascade,
  patient_label   text not null default '' check (length(patient_label) <= 80),
  blood_group     public.blood_group not null,
  hospital_name   text not null check (length(hospital_name) between 2 and 120),
  location_id     bigint not null references public.upazilas (id),
  location_text   text default '',
  units_needed    smallint not null check (units_needed between 1 and 20),
  interval_days   int not null check (interval_days between 1 and 365),
  contact_pref    text not null default 'in_app'
                  check (contact_pref in ('in_app','sms','phone_call')),
  consent_confirmed boolean not null default false,
  active          boolean not null default true,
  next_due_at     timestamptz not null default now(),
  last_request_id uuid references public.blood_requests (id) on delete set null,
  last_materialized_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists recurring_owner_idx on public.recurring_requests (creator_id, active);
create index if not exists recurring_due_idx on public.recurring_requests (next_due_at) where active;

alter table public.recurring_requests enable row level security;

do $$ begin
if not exists (select 1 from pg_policies where tablename='recurring_requests' and policyname='recurring_owner_rw') then
  create policy recurring_owner_rw on public.recurring_requests
    for select using (
      creator_id = auth.uid()
      or (select is_admin from public.profiles where id = auth.uid())
    );
end if;
end $$;

do $$ begin
if not exists (select 1 from pg_policies where tablename='recurring_requests' and policyname='recurring_owner_insert') then
  create policy recurring_owner_insert on public.recurring_requests
    for insert with check (creator_id = auth.uid() and consent_confirmed = true);
end if;
end $$;

-- Owner update of their own rows INCLUDING the consent reset guard: a paused
-- or deleted schedule keeps its identity; nothing is silently activated.
do $$ begin
if not exists (select 1 from pg_policies where tablename='recurring_requests' and policyname='recurring_owner_update') then
  create policy recurring_owner_update on public.recurring_requests
    for update using (creator_id = auth.uid()) with check (creator_id = auth.uid());
end if;
end $$;
