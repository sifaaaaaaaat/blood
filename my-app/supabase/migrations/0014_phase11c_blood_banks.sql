-- ============================================================================
-- Migration 0014: Phase 11C — Blood bank directory
--
-- DECISIONS (owner-approved for 11C):
--  · Directory-only scope: inventory/stock models are deliberately NOT here;
--    they land with 11F organization management.
--  · Empty start: no blood-bank records are seeded or fabricated. Real rows
--    are added ONLY by an admin, after sourcing from a legitimate source.
--  · Every record carries a mandatory source_note (provenance) so nothing in
--    the directory is unattributed.
--  · Admin-managed now: inserts/updates/publishing happen exclusively through
--    admin_* functions that re-verify is_admin against auth.uid() (same model
--    as Phase 10). Regular users have no write grants at all.
-- ============================================================================

begin;

create type public.blood_bank_kind as enum (
  'hospital_bank',        -- hospital-run blood bank / transfusion department
  'transfusion_center',   -- dedicated transfusion center
  'ngo_org',              -- voluntary organisation / social welfare
  'community_vault'       -- community-run donor vault
);

-- ---------------------------------------------------------------------------
-- blood_banks — one row per real blood bank/organisation
-- ---------------------------------------------------------------------------
create table public.blood_banks (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,79}$'),
  name           text not null check (char_length(name) between 2 and 150),
  name_bn        text check (name_bn is null or char_length(name_bn) between 2 and 150),
  kind           public.blood_bank_kind not null default 'hospital_bank',
  division_id    smallint not null references public.divisions (id) on delete restrict,
  district_id    smallint not null references public.districts (id) on delete restrict,
  upazila_id     integer references public.upazilas (id) on delete set null,
  -- address must pair district with a concrete detail; hierarchy FKs above.
  address        text not null check (char_length(address) between 5 and 300),
  -- Groups the bank reports it can ISSUE (for the blood-group filter).
  -- Empty array = "not reported yet" and the bank is excluded from
  -- blood-group-filtered results — never assumed to stock everything.
  groups_at_issue public.blood_group[] not null default '{}'::public.blood_group[],
  -- Public phone is optional and relies on the bank having published it.
  phone_public   text check (phone_public is null or phone_public ~ '^[0-9+][0-9-]{6,15}$'),
  opening_hours  text check (opening_hours is null or char_length(opening_hours) between 3 and 200),
  -- Mandatory provenance: e.g. 'DGHS hospital list 2026-10', 'org website …'.
  source_note    text not null check (char_length(source_note) between 4 and 240),
  is_published   boolean not null default false,
  published_at   timestamptz,
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index blood_banks_division_idx on public.blood_banks (division_id, is_published);
create index blood_banks_district_idx on public.blood_banks (district_id, is_published);
create index blood_banks_kind_idx on public.blood_banks (kind, is_published);

create trigger blood_banks_touch before update on public.blood_banks
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: published rows readable by anyone (anonymous included, matching the
-- public reference behaviour). NO write policy exists for any role — all
-- mutations happen through the admin_* functions below (security definer).
-- ---------------------------------------------------------------------------
alter table public.blood_banks enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'blood_banks' and policyname = 'blood_banks_public_read'
  ) then
    create policy blood_banks_public_read on public.blood_banks
      for select to anon, authenticated
      using (is_published);
  end if;
end $$;

revoke insert, update, delete on public.blood_banks from anon, authenticated;
grant select on public.blood_banks to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Shared domain validation for create + update (same rules the service layer
-- and Zod schema enforce; defence in depth).
-- ---------------------------------------------------------------------------
create or replace function public.blood_bank_location_valid(
  p_division smallint, p_district smallint, p_upazila integer
) returns boolean
language sql stable
set search_path = public
as $$
  select exists (
    select 1
      from public.districts d
     where d.id = p_district
       and d.division_id = p_division
  )
  and (
    p_upazila is null or exists (
      select 1 from public.upazilas u
       where u.id = p_upazila and u.district_id = p_district
    )
  )
$$;

-- ---------------------------------------------------------------------------
-- Admin RPCs. Convention identical to Phase 10: security definer, the role
-- check reads ONLY auth.uid() (never a client flag), every action audited.
-- ---------------------------------------------------------------------------
create or replace function public.admin_create_blood_bank(
  p_slug        text,
  p_name        text,
  p_name_bn     text default null,
  p_kind        text default 'hospital_bank',
  p_division    smallint default null,
  p_district    smallint default null,
  p_upazila     integer default null,
  p_address     text default null,
  p_groups      public.blood_group[] default '{}'::public.blood_group[],
  p_phone       text default null,
  p_hours       text default null,
  p_source_note text default null,
  p_publish     boolean default false
)
returns table (ok boolean, message text, bank_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  me      uuid := auth.uid();
  v_kind  public.blood_bank_kind;
  v_id    uuid;
begin
  if me is null or not public.app_is_admin(me) then
    return query select false, 'admin only', null::uuid;
    return;
  end if;
  if p_slug is null or p_name is null or p_address is null or p_source_note is null
     or p_division is null or p_district is null then
    return query select false, 'required fields missing', null::uuid;
    return;
  end if;
  if p_slug !~ '^[a-z0-9][a-z0-9-]{2,79}$' then
    return query select false, 'invalid slug', null::uuid;
    return;
  end if;
  if p_kind is not null and (p_kind::text not in ('hospital_bank','transfusion_center','ngo_org','community_vault')) then
    return query select false, 'unknown kind', null::uuid;
    return;
  end if;
  v_kind := coalesce(p_kind, 'hospital_bank')::public.blood_bank_kind;
  if not public.blood_bank_location_valid(p_division, p_district, p_upazila) then
    return query select false, 'district/upazila does not belong to the given division', null::uuid;
    return;
  end if;

  insert into public.blood_banks
    (slug, name, name_bn, kind, division_id, district_id, upazila_id,
     address, groups_at_issue, phone_public, opening_hours, source_note,
     is_published, published_at, created_by)
  values
    (p_slug, p_name, p_name_bn, v_kind, p_division, p_district, p_upazila,
     p_address, coalesce(p_groups, '{}'::public.blood_group[]), p_phone, p_hours, p_source_note,
     p_publish, case when p_publish then now() else null end, me)
  returning id into v_id;

  perform public.append_audit_log(
    'blood_bank.created',
    jsonb_build_object('bank', v_id, 'slug', p_slug, 'kind', v_kind,
                       'district', p_district, 'published', p_publish),
    me);
  return query select true, 'created', v_id;
exception
  when unique_violation then
    return query select false, 'slug already exists', null::uuid;
  when check_violation then
    return query select false, 'field validation failed', null::uuid;
end $$;

create or replace function public.admin_update_blood_bank(
  p_id           uuid,
  p_name         text default null,
  p_name_bn      text default null,
  p_kind         text default null,
  p_division     smallint default null,
  p_district     smallint default null,
  p_upazila      integer default null,
  p_address      text default null,
  p_groups       public.blood_group[] default null,
  p_phone        text default null,
  p_hours        text default null,
  p_source_note  text default null
)
returns table (ok boolean, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  me    uuid := auth.uid();
  v_div smallint; v_dis smallint; v_upa integer;
begin
  if me is null or not public.app_is_admin(me) then
    return query select false, 'admin only';
    return;
  end if;
  if p_id is null or not exists (select 1 from public.blood_banks where id = p_id) then
    return query select false, 'blood bank not found';
    return;
  end if;

  select division_id, district_id, upazila_id
    into v_div, v_dis, v_upa
    from public.blood_banks where id = p_id;

  -- Fall back to stored values so a partial update is still location-consistent.
  v_div := coalesce(p_division, v_div);
  v_dis := coalesce(p_district, v_dis);
  v_upa := coalesce(p_upazila, v_upa);
  if not public.blood_bank_location_valid(v_div, v_dis, v_upa) then
    return query select false, 'district/upazila does not belong to the given division';
    return;
  end if;

  update public.blood_banks set
    name          = coalesce(p_name, name),
    name_bn       = coalesce(p_name_bn, name_bn),
    kind          = coalesce(p_kind, kind)::public.blood_bank_kind,
    division_id   = v_div,
    district_id   = v_dis,
    upazila_id    = v_upa,
    address       = coalesce(p_address, address),
    groups_at_issue = coalesce(p_groups, groups_at_issue),
    phone_public  = coalesce(p_phone, phone_public),
    opening_hours = coalesce(p_hours, opening_hours),
    source_note   = coalesce(p_source_note, source_note)
  where id = p_id;

  perform public.append_audit_log(
    'blood_bank.updated',
    jsonb_build_object('bank', p_id, 'fields',
      (select key from (select unnest(array['name','name_bn','kind','division','district','upazila','address','groups','phone','hours','source']) as key, unnest(array[p_name is not null, p_name_bn is not null, p_kind is not null, p_division is not null, p_district is not null, p_upazila is not null, p_address is not null, p_groups is not null, p_phone is not null, p_hours is not null, p_source_note is not null]) as set) s where s.set)),
    me);
  return query select true, 'updated';
exception
  when unique_violation then
    return query select false, 'conflict with existing record';
  when check_violation then
    return query select false, 'field validation failed';
end $$;

create or replace function public.admin_publish_blood_bank(p_id uuid, p_publish boolean)
returns table (ok boolean, message text)
language plpgsql
security definer
set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if me is null or not public.app_is_admin(me) then
    return query select false, 'admin only';
    return;
  end if;
  update public.blood_banks
     set is_published = p_publish,
         published_at = case
           when p_publish and published_at is null then now()
           when p_publish then published_at
           else null end
   where id = p_id;
  if not found then
    return query select false, 'blood bank not found';
    return;
  end if;
  perform public.append_audit_log(
    'blood_bank.publish_changed', jsonb_build_object('bank', p_id, 'published', p_publish), me);
  return query select true, case when p_publish then 'published' else 'unpublished' end;
end $$;

revoke execute on function public.blood_bank_location_valid(smallint, smallint, integer) from anon;
grant execute on function public.blood_bank_location_valid(smallint, smallint, integer) to authenticated, service_role;
revoke execute on function public.admin_create_blood_bank from anon;
grant execute on function public.admin_create_blood_bank to authenticated, service_role;
revoke execute on function public.admin_update_blood_bank from anon;
grant execute on function public.admin_update_blood_bank to authenticated, service_role;
revoke execute on function public.admin_publish_blood_bank from anon;
grant execute on function public.admin_publish_blood_bank to authenticated, service_role;

commit;
