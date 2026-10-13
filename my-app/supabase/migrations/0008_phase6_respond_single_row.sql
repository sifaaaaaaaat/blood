-- Migration 0008: donor_respond_match rewritten with OUT params.
-- The prior RETURNS TABLE + RETURN QUERY variant accumulated one row per
-- RETURN QUERY executed in a single call — wrong. Each call must produce
-- exactly one opinionated row.

begin;

drop function if exists public.donor_respond_match(uuid, text, uuid, text);

create or replace function public.donor_respond_match(
  p_match_id uuid,
  p_action   text,
  p_donor    uuid,
  p_source   text default 'in_app',
  out ok        boolean,
  out status    public.match_status,
  out message   text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.request_matches%rowtype;
  r public.blood_requests%rowtype;
  accepted_count integer;
begin
  select * into m from public.request_matches where id = p_match_id for update;
  if not found then
    ok := false; status := null; message := 'match not found'; return;
  end if;
  if m.donor_id <> p_donor then
    ok := false; status := null; message := 'not your match'; return;
  end if;

  select * into r from public.blood_requests where id = m.request_id;
  if r.status in ('cancelled', 'expired', 'flagged', 'fulfilled') then
    update public.request_matches
       set status = 'cancelled_with_request', updated_at = now()
     where id = m.id;
    ok := false; status := 'cancelled_with_request';
    message := 'request is ' || r.status::text; return;
  end if;
  if r.status = 'draft' then
    ok := false; status := null; message := 'request not open for response'; return;
  end if;
  if m.expires_at < now() then
    update public.request_matches set status='expired', updated_at=now() where id = m.id;
    ok := false; status := 'expired'; message := 'match expired'; return;
  end if;
  if m.status not in ('pending','notified') then
    ok := false; status := m.status; message := 'already responded'; return;
  end if;

  if p_action = 'accept' then
    select count(*)::int into accepted_count
      from public.request_matches rm
     where rm.request_id = m.request_id and rm.status = 'accepted';
    if accepted_count >= r.units_needed then
      update public.request_matches
         set status = 'unavailable', updated_at = now()
       where id = m.id and request_matches.status in ('pending','notified');
      ok := false; status := 'unavailable';
      message := 'enough donors accepted already'; return;
    end if;
    update public.request_matches
       set status='accepted', accepted_at=now(), responded_at=now(),
           response_source=p_source, updated_at=now()
     where id = m.id;
    perform public.append_audit_log('match.accept',
      jsonb_build_object('match_id', m.id, 'request_id', m.request_id), p_donor);
    ok := true; status := 'accepted'; message := null; return;

  elsif p_action = 'decline' then
    update public.request_matches
       set status='declined', declined_at=now(), responded_at=now(),
           response_source=p_source, updated_at=now()
     where id = m.id;
    perform public.append_audit_log('match.decline',
      jsonb_build_object('match_id', m.id, 'request_id', m.request_id), p_donor);
    ok := true; status := 'declined'; message := null; return;

  elsif p_action = 'unavailable' then
    update public.request_matches
       set status='unavailable', responded_at=now(),
           response_source=p_source, updated_at=now()
     where id = m.id;
    perform public.append_audit_log('match.unavailable',
      jsonb_build_object('match_id', m.id, 'request_id', m.request_id), p_donor);
    ok := true; status := 'unavailable'; message := null; return;

  else
    ok := false; status := null; message := 'unknown action'; return;
  end if;
end;
$$;

revoke execute on function public.donor_respond_match(uuid, text, uuid, text) from anon, authenticated;

commit;
