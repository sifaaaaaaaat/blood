-- Phase 12: grant hardening.
--
-- Phase 2's blanket "GRANT ALL ... TO anon, authenticated" survives RLS for
-- normal reads/writes, but TRUNCATE is a TABLE-level operation that RLS
-- cannot gate, and an unauthenticated (anon-key) caller has no legitimate
-- reason to mutate rows. This tightens grants without changing any behavior:
--  · TRUNCATE / REFERENCES / TRIGGER revoked from everyone (app never uses them)
--  · INSERT/UPDATE/DELETE revoked from anon entirely (RLS-gated writes such as
--    donor registration, requests and referrals all happen signed-in)
--  · SELECT stays for both (RLS policies own row-visibility everywhere)

begin;

do $$
declare
  t record;
  g record;
begin
  for t in
    select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('revoke truncate, references, trigger on public.%I from anon, authenticated', t.relname);
    execute format('revoke insert, update, delete on public.%I from anon', t.relname);
    -- authenticated keeps DML: every write is gated by RLS policies and the
    -- app relies on signed-in session inserts through them.
    execute format('grant insert, update, delete, select on public.%I to authenticated', t.relname);
  end loop;

  -- remove leftover write grants from anon/authenticated regardless
  for g in
    select grantee, table_name from information_schema.table_privileges
     where table_schema = 'public'
       and grantee in ('anon')
       and privilege_type in ('INSERT','UPDATE','DELETE')
  loop
    execute format('revoke insert, update, delete on public.%I from %I', g.table_name, g.grantee);
  end loop;
end $$;

-- keep every anon SELECT that is meant for public reads

commit;
