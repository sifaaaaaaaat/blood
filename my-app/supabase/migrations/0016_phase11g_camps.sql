-- Phase 11G: donation camps.
--
-- Camps exist ONLY as real, admin-vetted records with a citable source —
-- the platform's standing no-invented-data rule applies verbatim. The public
-- listing selects published rows only (same visibility pattern as 11C banks),
-- and every admin write is re-verified inside Postgres, not the app layer.

create table if not exists public.camps (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(name) between 2 and 160),
  name_bn       text,
  org_name      text not null check (length(org_name) between 2 and 160),
  division_id   bigint references public.divisions (id),
  district_id   bigint references public.districts (id),
  location_text text not null default '',
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  source_note   text not null default '',
  is_published  boolean not null default false,
  published_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (ends_at >= starts_at)
);

create index if not exists camps_upcoming_idx on public.camps (starts_at) where is_published;

alter table public.camps enable row level security;

do $$ begin
if not exists (select 1 from pg_policies where tablename='camps' and policyname='camps_public_select') then
  create policy camps_public_select on public.camps
    for select using (
      is_published
      or (select is_admin from public.profiles where id = auth.uid())
    );
end if;
end $$;

-- Admin create/update. Re-verifies the platform admin role from auth.uid()
-- inside the function (a forged app flag can never write), stamps publish
-- time when flipping to published, and leaves history intact.
create or replace function public.admin_camp_upsert(
  -- Required params first: Postgres forbids non-defaulted params after one
  -- with a default (callers use named arguments, so order is cosmetic).
  p_name         text,
  p_org_name     text,
  p_id           uuid default null,
  p_name_bn      text default null,
  p_division     bigint default null,
  p_district     bigint default null,
  p_location     text default '',
  p_starts_at    timestamptz default null,
  p_ends_at      timestamptz default null,
  p_source_note  text default '',
  p_is_published boolean default false
) returns public.camps
language plpgsql security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_admin boolean;
  v_row   public.camps;
  v_existing public.camps%rowtype;
begin
  if v_user is null then raise exception 'not signed in'; end if;
  select is_admin into v_admin from public.profiles where id = v_user;
  if not coalesce(v_admin, false) then raise exception 'admin only'; end if;

  if p_id is not null then
    select * into v_existing from public.camps where id = p_id;
    if not found then raise exception 'camp not found'; end if;
  end if;

  -- started/past camps cannot switch to discovered-late publish times.
  declare
    v_starts timestamptz := coalesce(p_starts_at, v_existing.starts_at, now());
    v_ends   timestamptz := coalesce(p_ends_at,   v_existing.ends_at, now());
  begin
    if v_ends < v_starts then raise exception 'ends_at before starts_at'; end if;
    if v_starts > now() + interval '2 years' then raise exception 'starts_at too far ahead'; end if;

    if p_id is null then
      insert into public.camps (name, name_bn, org_name, division_id, district_id, location_text, starts_at, ends_at, source_note, is_published, published_at)
      values (p_name, p_name_bn, p_org_name, p_division, p_district, p_location, v_starts, v_ends, p_source_note, p_is_published,
              case when p_is_published then now() else null end)
      returning * into v_row;
    else
      update public.camps set
        name = p_name, name_bn = p_name_bn, org_name = p_org_name,
        division_id = p_division, district_id = p_district, location_text = p_location,
        starts_at = v_starts, ends_at = v_ends, source_note = p_source_note,
        is_published = p_is_published,
        published_at = case when p_is_published then coalesce(published_at, now()) else null end,
        updated_at = now()
      where id = p_id
      returning * into v_row;
    end if;
  end;
  return v_row;
end $$;
