-- Phase 11F: organization management for blood banks.
--
--   · bank_orgs   — membership: an account may administer or manage inventory
--                   for a blood bank the ADMIN seeded (11C). The platform
--                   keeps authorship: reports are tied to a named account.
--   · bank_stock  — timestamped stock updates from legitimate bank sources.
--                   Directory shows a stock line ONLY once a member reported
--                   it (verified by origin, not by guesswork), matching the
--                   long-standing "no invented stock" rule.
--
-- Public reads go through service-role directory paths; RLS restricts direct
-- access to members and platform admins, inserts to the org itself.

create table if not exists public.bank_orgs (
  id         uuid primary key default gen_random_uuid(),
  bank_id    uuid not null references public.blood_banks (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       text not null default 'inventory' check (role in ('admin','inventory')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bank_id, user_id)
);

create index if not exists bank_orgs_user_idx on public.bank_orgs (user_id);

create table if not exists public.bank_stock (
  id           uuid primary key default gen_random_uuid(),
  bank_id      uuid not null references public.blood_banks (id) on delete cascade,
  blood_group  public.blood_group not null,
  units        smallint not null check (units between 0 and 10000),
  source_note  text,
  reported_by  uuid not null references public.profiles (id) on delete cascade,
  created_at   timestamptz not null default now()
);

create index if not exists bank_stock_bank_recent_idx
  on public.bank_stock (bank_id, blood_group, created_at desc);

alter table public.bank_orgs  enable row level security;
alter table public.bank_stock enable row level security;

-- Members can see their own org links; platform admins see all.
do $$ begin
if not exists (select 1 from pg_policies where tablename='bank_orgs' and policyname='bank_orgs_member_select') then
  create policy bank_orgs_member_select on public.bank_orgs
    for select using (
      user_id = auth.uid()
      or exists (select 1 from public.platform_roles r where r.user_id = auth.uid() and r.is_moderator)
      or (select is_admin from public.profiles where id = auth.uid())
    );
end if;
end $$;

-- Inserts come only from service-role provisioning (admins add members via
-- the admin API); no user-facing INSERT policy by design.

do $$ begin
if not exists (select 1 from pg_policies where tablename='bank_stock' and policyname='bank_stock_member_select') then
  create policy bank_stock_member_select on public.bank_stock
    for select using (
      exists (select 1 from public.bank_orgs o where o.bank_id = bank_stock.bank_id and o.user_id = auth.uid())
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
    );
end if;
end $$;

-- Add a stock update from the BANK itself. Called through the org API with
-- the server verifying membership (and never trusting client ids).
create or replace function public.report_bank_stock(
  p_bank_id     uuid,
  p_updates     jsonb,   -- [{ blood_group: "O+", units: 3 }, ...]
  p_source_note text default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_member boolean;
  v_inserted integer := 0;
  v_row jsonb;
begin
  if v_user is null then
    raise exception 'not signed in';
  end if;
  select exists (select 1 from public.bank_orgs o where o.bank_id = p_bank_id and o.user_id = v_user) into v_member;
  if not v_member then
    raise exception 'you are not a member of this blood bank';
  end if;

  for v_row in select * from jsonb_array_elements(p_updates) loop
    insert into public.bank_stock (bank_id, blood_group, units, source_note, reported_by)
    values (
      p_bank_id,
      (v_row->>'blood_group')::public.blood_group,
      (v_row->>'units')::smallint,
      p_source_note,
      v_user
    );
    v_inserted := v_inserted + 1;
  end loop;
  return v_inserted;
end $$;

-- Latest stock per (bank, group) for the public directory.
create or replace function public.latest_bank_stock(p_bank_id uuid)
returns table (blood_group public.blood_group, units smallint, reported_at timestamptz, reported_by uuid)
language sql stable security definer set search_path = public as $$
  select s.blood_group, s.units, s.created_at, s.reported_by
    from public.bank_stock s
   where s.bank_id = p_bank_id
     and s.created_at = (
       select max(m.created_at) from public.bank_stock m
        where m.bank_id = p_bank_id and m.blood_group = s.blood_group
     )
   order by s.blood_group
$$;
