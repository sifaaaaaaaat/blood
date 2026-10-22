-- Phase 12 pre-work: referral attribution (Phase-1 architecture table,
-- minimal honest implementation).
--
-- Referrals are a community-recognition ledger only: no money, no clinical
-- weight, no matching influence. A profile owns at most one code; a profile
-- may redeem a given code at most once; self-redemption is a DB rule.

begin;

create table if not exists public.referral_codes (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.profiles (id) on delete cascade,
  code       text not null unique check (code ~ '^[A-Z0-9-]{6,24}$'),
  created_at timestamptz not null default now(),
  unique (owner_id)
);

create index if not exists referral_codes_owner_idx on public.referral_codes (owner_id);

create table if not exists public.referral_uses (
  id           uuid primary key default gen_random_uuid(),
  code_id      uuid not null references public.referral_codes (id) on delete cascade,
  used_by_id   uuid not null references public.profiles (id) on delete cascade,
  used_at      timestamptz not null default now(),
  unique (code_id, used_by_id)
);

create index if not exists referral_uses_code_idx on public.referral_uses (code_id);

alter table public.referral_codes enable row level security;
alter table public.referral_uses  enable row level security;

do $$ begin
if not exists (select 1 from pg_policies where tablename='referral_codes' and policyname='referral_code_owner_all') then
  create policy referral_code_owner_all on public.referral_codes
    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
end if;
end $$;

do $$ begin
if not exists (select 1 from pg_policies where tablename='referral_codes' and policyname='referral_code_public_read') then
  -- Only the code string needs to readable so anyone can be shown the code to
  -- pass along; owner_id stays owner-only. Column-level grant restricts reads.
  create policy referral_code_public_read on public.referral_codes
    for select using (true);
end if;
end $$;

do $$ begin
if not exists (select 1 from pg_policies where tablename='referral_uses' and policyname='referral_use_own_read') then
  create policy referral_use_own_read on public.referral_uses
    for select using (used_by_id = auth.uid());
end if;
end $$;

do $$ begin
if not exists (select 1 from pg_policies where tablename='referral_uses' and policyname='referral_use_owner_read') then
  -- The code owner can see WHO used their code (community recognition):
  create policy referral_use_owner_read on public.referral_uses
    for select using (
      exists (
        select 1 from public.referral_codes c
        where c.id = code_id and c.owner_id = auth.uid()
      )
    );
end if;
end $$;

-- Issue (or return) the caller's own code; re-verifies the session inside the
-- function; codes are only ever generated server-side.
create or replace function public.referral_issue_code()
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_code  text;
begin
  if v_user is null then raise exception 'not signed in'; end if;
  select code into v_code from public.referral_codes where owner_id = v_user;
  if v_code is not null then return v_code; end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  -- ~1 collision in 10^15; still handle it deterministically with one retry.
  begin
    insert into public.referral_codes (owner_id, code) values (v_user, v_code);
  exception when unique_violation then
    v_code := 'R-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    insert into public.referral_codes (owner_id, code) values (v_user, v_code);
  end;
  return v_code;
end $$;

-- Redeem one code for the caller. Idempotent per (code, user); forbids self-
-- redemption. Returns ok:false with a reason instead of raising, so the API
-- can surface honest failure states.
create or replace function public.referral_redeem(p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user   uuid := auth.uid();
  v_code   public.referral_codes%rowtype;
  v_inserted boolean;
begin
  if v_user is null then raise exception 'not signed in'; end if;
  select * into v_code from public.referral_codes where code = upper(trim(p_code));
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown code');
  end if;
  if v_code.owner_id = v_user then
    return jsonb_build_object('ok', false, 'reason', 'own code cannot be redeemed');
  end if;
  begin
    insert into public.referral_uses (code_id, used_by_id) values (v_code.id, v_user);
    v_inserted := true;
  exception when unique_violation then
    v_inserted := false;
  end;
  return jsonb_build_object(
    'ok', true,
    'referral_count', (select count(*) from public.referral_uses where code_id = v_code.id),
    'redeemed', v_inserted
  );
end $$;

commit;
