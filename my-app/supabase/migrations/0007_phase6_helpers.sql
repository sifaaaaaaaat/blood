-- Migration 0007: helper for outreach governance (phase 6).
begin;

create or replace function public.count_accepted_for_request(p_request_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::int from public.request_matches
   where request_id = p_request_id and status = 'accepted';
$$;

revoke execute on function public.count_accepted_for_request(uuid) from anon, authenticated;

commit;
