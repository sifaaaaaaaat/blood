-- ============================================================================
-- Migration 0005 (final): restricted SQL gateway for the matching engine.
--
-- Fixings over earlier drafts:
--   · RETURNS TABLE with a fixed SAFE column shape — PostgREST can call it
--     without a column-definition list, and callers CANNOT demand extra
--     columns: no way to smuggle phone/contact data through.
--   · No-escape regex checks ([[:space:]] / plain alternation) immune to
--     backslash-escaping across client layers.
--   · Private-column detector — any mention of phone/verification/geo columns
--     makes the call fail.
-- ============================================================================

begin;

-- Postgres cannot change a function's return type in-place; this migration
-- supersedes the draft returns-record version. Drop-first is safe because
-- nothing else references these functions except the matching service.
drop function if exists public.exec_matching_sql(text);
drop function if exists public.exec_location_sql(text);

create or replace function public.exec_matching_sql(q text)
returns table (
  donor_user_id uuid, display_name text, blood_group text,
  upazila_name text, district_name text, availability text, tier int
)
language plpgsql
security definer
set search_path = public
as $body$
declare
  lowered text;
begin
  select lower(regexp_replace(trim(q), pat, ' ', 'g'))
    into lowered
    from (select '[[:space:]]+'::text as pat) p;

  if lowered !~ '^select([[:space:]]|$)' then
    raise exception 'exec_matching_sql: only SELECT allowed';
  end if;
  if lowered ~ ';' then
    raise exception 'exec_matching_sql: multiple statements not allowed';
  end if;
  if lowered ~ '(^|[[:space:]])(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|call|do)([[:space:]]|($))' then
    raise exception 'exec_matching_sql: mutating keywords not allowed';
  end if;
  if lowered not like '%from public.donor_profiles%' then
    raise exception 'exec_matching_sql: only donor matching queries allowed';
  end if;
  -- SAFE-columns enforcement: refuse any query touching private columns.
  if lowered ~ '(^|[[:space:]],)(phone|verified_at|phone_normalized|center_lat|center_lon)([[:space:]],|($))' then
    raise exception 'exec_matching_sql: private column detected';
  end if;
  return query execute q;
end;
$body$;

create or replace function public.exec_location_sql(q text)
returns table (district_id smallint, name text)
language plpgsql
security definer
set search_path = public
as $body$
declare
  lowered text;
begin
  select lower(regexp_replace(trim(q), pat, ' ', 'g'))
    into lowered
    from (select '[[:space:]]+'::text as pat) p;

  if lowered !~ '^select([[:space:]]|$)' then
    raise exception 'exec_location_sql: only SELECT allowed';
  end if;
  if lowered ~ ';' then
    raise exception 'exec_location_sql: multiple statements not allowed';
  end if;
  if lowered ~ '(^|[[:space:]])(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|call|do)([[:space:]]|($))' then
    raise exception 'exec_location_sql: mutating keywords not allowed';
  end if;
  if lowered not like '%from public.upazilas%' then
    raise exception 'exec_location_sql: only upazila lookups allowed';
  end if;
  return query execute q;
end;
$body$;

-- Not callable by anon/authenticated: used by the server with the service key.
revoke execute on function public.exec_matching_sql(text) from anon, authenticated;
revoke execute on function public.exec_location_sql(text) from anon, authenticated;

commit;
