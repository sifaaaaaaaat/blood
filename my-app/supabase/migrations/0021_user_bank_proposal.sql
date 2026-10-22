-- Migration 0021: user blood-bank proposals (directory self-service).
--
-- A signed-in user can PROPOSE a blood bank to the directory. The proposal is
-- stored exactly like every other bank row (mandatory provenance source_note)
-- but unpublished: it is invisible in the public directory until an admin
-- publishes it via the existing admin_publish_blood_bank / PATCH path.
-- This respects the Phase 11C decision that nothing enters the directory
-- unattributed — the submitter's account is recorded in created_by and every
-- proposal is audited.
--
-- No write grants on blood_banks for users: the insert happens inside this
-- security-definer function, which validates the location hierarchy and
-- generates the unique slug server-side.

begin;

create or replace function public.user_propose_blood_bank(
  p_name        text,
  p_division    smallint,
  p_district    smallint,
  p_address     text,
  p_source_note text,
  p_name_bn     text default null,
  p_kind        text default 'hospital_bank',
  p_upazila     integer default null,
  p_phone       text default null,
  p_hours       text default null
) returns table (ok boolean, message text, bank_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  me          uuid := auth.uid();
  v_kind      public.blood_bank_kind;
  v_slug      text;
  v_id        uuid;
begin
  if me is null then
    return query select false, 'sign in first', null::uuid;
    return;
  end if;
  if p_name is null or char_length(p_name) < 2 or char_length(p_name) > 150
     or p_address is null or char_length(p_address) < 5 or char_length(p_address) > 300
     or p_source_note is null or char_length(p_source_note) < 4 or char_length(p_source_note) > 240
     or p_division is null or p_district is null then
    return query select false, 'required fields missing or too long', null::uuid;
    return;
  end if;
  if p_name_bn is not null and char_length(p_name_bn) not between 2 and 150 then
    return query select false, 'invalid Bangla name', null::uuid;
    return;
  end if;
  if p_phone is not null and p_phone !~ '^[0-9+][0-9-]{6,15}$' then
    return query select false, 'invalid phone', null::uuid;
    return;
  end if;
  if p_hours is not null and char_length(p_hours) not between 3 and 200 then
    return query select false, 'invalid opening hours', null::uuid;
    return;
  end if;
  v_kind := coalesce(p_kind, 'hospital_bank')::public.blood_bank_kind;
  if not public.blood_bank_location_valid(p_division, p_district, p_upazila) then
    return query select false, 'district/upazila does not belong to the given division', null::uuid;
    return;
  end if;

  -- Server-generated unique slug (never client-supplied): user-<12 hex>.
  v_slug := 'user-' || left(replace(gen_random_uuid()::text, '-', ''), 12);

  insert into public.blood_banks
    (slug, name, name_bn, kind, division_id, district_id, upazila_id,
     address, groups_at_issue, phone_public, opening_hours, source_note,
     is_published, published_at, created_by)
  values
    (v_slug, p_name, p_name_bn, v_kind, p_division, p_district, p_upazila,
     p_address, '{}'::public.blood_group[], p_phone, p_hours, p_source_note,
     false, null, me)
  returning id into v_id;

  perform public.append_audit_log(
    'blood_bank.proposed',
    jsonb_build_object('bank', v_id, 'slug', v_slug, 'kind', v_kind,
                       'district', p_district), me);
  return query select true, 'proposed — pending review', v_id;
exception
  when check_violation then
    return query select false, 'field validation failed', null::uuid;
end $$;

revoke execute on function public.user_propose_blood_bank from anon, public;
grant execute on function public.user_propose_blood_bank to authenticated, service_role;

commit;
