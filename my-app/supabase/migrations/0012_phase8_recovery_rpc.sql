-- ============================================================================
-- Phase 8 RPCs: donor report/confirm, admin verify/rules/override, recovery
-- state. All authorization checks run INSIDE these security-definer
-- functions (auth.uid() + profiles.is_admin) so client input can never pick
-- the acting identity.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- donor_report_donation: donor reports a donation (self-reported - plain
-- unverified data). If an active APPROVED rule exists for the type, computes
-- the administrative hold (conflict-safe: uses the LATEST date among
-- conflicting reports) and pauses the donor until the hold is resolved.
-- ---------------------------------------------------------------------------
create or replace function public.donor_report_donation(
  p_donation_date date,
  p_type text,
  p_facility text,
  p_note text
)
returns table (ok boolean, state text, message text, hold_until date, conflict_with uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  conflict uuid;
  effective_date date;
  rule record;
  reason text;
begin
  if me is null then
    return query select false, 'unauthorized', 'sign-in required', null::date, null::uuid;
    return;
  end if;
  if p_type not in ('whole_blood','power_red','plasma','platelets') then
    return query select false, 'validation_error', 'unknown donation type', null::date, null::uuid;
    return;
  end if;
  if p_donation_date > current_date
     or p_donation_date < current_date - 3650 then
    -- missing / implausible dates handled safely: reject out-of-window dates
    return query select false, 'validation_error', 'donation date must be within the last 10 years and not in the future', null::date, null::uuid;
    return;
  end if;

  -- Conflict-safe: same donor + type with a DIFFERENT date within 3 days is
  -- treated as a conflicting report; exclusion uses the most conservative
  -- (latest) date and links both records for review.
  select r.id into conflict
    from public.donation_records r
   where r.donor_id = me
     and r.donation_type::text = p_type
     and abs(r.donation_date - p_donation_date) <= 3
     and r.donation_date <> p_donation_date
   order by r.donation_date desc
   limit 1;

  if conflict is not null then
    select greatest(r2.donation_date, p_donation_date) into effective_date
      from public.donation_records r2 where r2.id = conflict;
  else
    effective_date := p_donation_date;
  end if;

  insert into public.donation_records
    (donor_id, donation_date, donation_type, facility, report_note, source, conflict_with)
  values
    (me, p_donation_date, p_type::public.donation_type, nullif(trim(coalesce(p_facility,'')), ''), nullif(trim(coalesce(p_note,'')), ''), 'self_reported', conflict);

  perform public.append_audit_log('donation.reported',
    jsonb_build_object('donor', me, 'type', p_type, 'date', p_donation_date,
                       'conflict_with', conflict), me);

  -- Administrative hold ONLY when an approved rule covers this type.
  select * into rule
    from public.recovery_rules
   where donation_type::text = p_type and active
   order by created_at desc limit 1;

  if rule is not null then
    effective_date := greatest(effective_date, p_donation_date); -- recompute safely
    reason := 'Recovery hold: ' || p_type || ' donation reported on ' || p_donation_date::text ||
              '. Outreach is paused until ' || (effective_date + rule.exclusion_days)::text ||
              ' under the recovery rule approved by ' || rule.approved_by_name ||
              ' (ref ' || rule.approval_reference || '). When the period ends you will be asked to confirm your availability - the platform does not declare anyone medically eligible.';

    insert into public.donor_recovery_holds
      (donor_id, until_date, reason, based_on_record, rule_id)
    values
      (me, effective_date + rule.exclusion_days, reason,
       (select id from public.donation_records where donor_id = me and donation_date = p_donation_date and donation_type::text = p_type order by created_at desc limit 1),
       rule.id)
    on conflict (donor_id) do update
      set until_date = excluded.until_date,
          reason = excluded.reason,
          based_on_record = excluded.based_on_record,
          rule_id = excluded.rule_id,
          lifted = false,
          lifted_by = null, lifted_by_role = null,
          lifted_note = null, lifted_at = null,
          updated_at = now();

    update public.donor_profiles set availability = 'paused', paused_until = null, updated_at = now()
     where user_id = me;

    perform public.append_audit_log('donor.hold_applied',
      jsonb_build_object('donor', me, 'until', effective_date + rule.exclusion_days, 'rule', rule.id), me);

    return query select true, 'hold_applied', reason, effective_date + rule.exclusion_days, conflict;
  end if;

  return query select true, 'recorded_no_rule',
    'Recorded as self-reported. No approved recovery rule is configured for this donation type, so no automatic exclusion applies.',
    null::date, conflict;
end $$;

-- ---------------------------------------------------------------------------
-- donor_confirm_availability: after the hold's date, the DONOR (not the
-- system) confirms availability to resume matching. Refused while the hold
-- window is still active - only a permission-controlled admin override can
-- clear it early, and that path is audited with the medical authority's name.
-- ---------------------------------------------------------------------------
create or replace function public.donor_confirm_availability()
returns table (ok boolean, state text, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  h public.donor_recovery_holds%rowtype;
begin
  if me is null then
    return query select false, 'unauthorized', 'sign-in required';
    return;
  end if;
  select * into h from public.donor_recovery_holds where donor_id = me;
  if not found or h.lifted then
    update public.donor_profiles set availability = 'available', paused_until = null, updated_at = now() where user_id = me;
    return query select true, 'active', 'No active hold; availability confirmed.';
  end if;
  if h.until_date >= current_date then
    return query select false, 'hold_active',
      'Recovery hold is active until ' || h.until_date::text || '. Your availability window has not ended yet.';
  end if;
  update public.donor_recovery_holds
     set lifted = true, lifted_by = me, lifted_by_role = 'donor',
         lifted_note = 'Donor confirmed availability after the exclusion period ended',
         lifted_at = now(), updated_at = now()
   where donor_id = me;
  update public.donor_profiles
     set availability = 'available', paused_until = null, updated_at = now()
   where user_id = me;
  perform public.append_audit_log('donor.hold_released', jsonb_build_object('donor', me), me);
  return query select true, 'active', 'Availability confirmed; you are back in the matching pool. Remember to follow local eligibility guidance.';
end $$;

-- ---------------------------------------------------------------------------
-- donor_recovery_state: donor-facing status. NEVER returns any notion of
-- "medically eligible" - only administrative states.
-- ---------------------------------------------------------------------------
create or replace function public.donor_recovery_state(p_donor uuid)
returns table (state text, hold_until date, reason text, paused boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  h public.donor_recovery_holds%rowtype;
  prof public.donor_profiles%rowtype;
begin
  if not (auth.uid() = p_donor
          or exists (select 1 from public.profiles pr where pr.id = auth.uid() and pr.is_admin)) then
    raise exception 'donor_recovery_state: not authorized for donor %', p_donor;
  end if;
  select * into h from public.donor_recovery_holds where donor_id = p_donor;
  select * into prof from public.donor_profiles where user_id = p_donor;

  -- found + boolean check: a rowtype `h is not null` is false when ANY field
  -- is null (e.g. lifted_note on a fresh hold), so never gate on it here.
  if found and h.lifted is false then
    if h.until_date >= current_date then
      return query select 'recovery_hold', h.until_date, h.reason,
        coalesce(prof.availability = 'paused', false);
      return;
    end if;
    return query select 'awaiting_confirmation', h.until_date,
      'The exclusion period ended on ' || h.until_date::text || '. Please confirm your availability to rejoin matching. Follow your local eligibility guidance.', coalesce(prof.availability = 'paused', false);
    return;
  end if;
  return query select 'active', null::date, null::text,
    coalesce((select prof.availability = 'paused'), false);
end $$;

-- ---------------------------------------------------------------------------
-- admin_verify_donation: verification status stored SEPARATELY from the
-- donor-reported fields; admin (or admin-recorded partner attestation) only.
-- ---------------------------------------------------------------------------
create or replace function public.admin_verify_donation(
  p_record uuid,
  p_status text,            -- 'verified' | 'rejected' | 'unverified'
  p_basis text,
  p_actor_role text default 'admin'   -- 'partner' attestation recorded by admin
)
returns table (ok boolean, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not exists (select 1 from public.profiles pr where pr.id = me and pr.is_admin) then
    return query select false, 'admin only';
    return;
  end if;
  if p_status not in ('verified','rejected','unverified') then
    return query select false, 'invalid status';
    return;
  end if;
  if p_status = 'verified' and nullif(trim(coalesce(p_basis,'')), '') is null then
    return query select false, 'verification basis is required to mark a record verified';
    return;
  end if;
  if p_actor_role not in ('admin','partner') then
    return query select false, 'invalid actor role';
    return;
  end if;

  update public.donation_records
     set verification = p_status::public.verification_status,
         verification_actor_role = p_actor_role,
         verification_actor = me,
         verified_at = now(),
         verified_basis = nullif(trim(coalesce(p_basis,'')), ''),
         updated_at = now()
   where id = p_record;

  perform public.append_audit_log('donation.verification_changed',
    jsonb_build_object('record', p_record, 'status', p_status, 'actor_role', p_actor_role), me);
  return query select true, p_status;
end $$;

-- ---------------------------------------------------------------------------
-- admin_set_recovery_rule: THE ONLY way recovery windows come into effect.
-- Requires a named qualified approver + reference. Later rules NEVER extend
-- an already-computed hold that donor was told about - they can only shorten
-- it (donor-favoring) or affect future reports.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_recovery_rule(
  p_type text,
  p_days integer,
  p_approved_by_name text,
  p_approval_reference text
)
returns table (ok boolean, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  rule_id uuid;
begin
  if me is null or not exists (select 1 from public.profiles pr where pr.id = me and pr.is_admin) then
    return query select false, 'admin only';
    return;
  end if;
  if p_type not in ('whole_blood','power_red','plasma','platelets') then
    return query select false, 'unknown donation type';
    return;
  end if;
  if p_days < 0 or p_days > 3650 then
    return query select false, 'exclusion days out of range';
    return;
  end if;
  if nullif(trim(coalesce(p_approved_by_name,'')), '') is null
     or nullif(trim(coalesce(p_approval_reference,'')), '') is null then
    return query select false, 'rule must name the qualified approver and a reference - unapproved rules cannot activate';
    return;
  end if;

  update public.recovery_rules set active = false where donation_type::text = p_type;

  insert into public.recovery_rules
    (donation_type, exclusion_days, active, approved_by_name, approval_reference, approved_by_user)
  values
    (p_type::public.donation_type, p_days, true, trim(p_approved_by_name), trim(p_approval_reference), me)
  returning id into rule_id;

  -- Shorten-only recompute of unlifted holds for this type (never extend).
  update public.donor_recovery_holds h
     set until_date = least(h.until_date,
         (select r.donation_date from public.donation_records r where r.id = h.based_on_record) + p_days),
         reason = h.reason || ' [Updated rule ref ' || trim(p_approval_reference) || ' applied: exclusion shortened to ' || ((select r.donation_date from public.donation_records r where r.id = h.based_on_record) + p_days)::text || ']'
   where h.lifted = false and h.rule_id in (select id from public.recovery_rules where donation_type::text = p_type)
     and h.until_date > ((select r.donation_date from public.donation_records r where r.id = h.based_on_record) + p_days);

  perform public.append_audit_log('recovery_rule.set',
    jsonb_build_object('type', p_type, 'days', p_days, 'approver', p_approved_by_name,
                       'reference', p_approval_reference, 'rule', rule_id), me);
  return query select true, 'rule active for ' || p_type;
end $$;

-- ---------------------------------------------------------------------------
-- admin_lift_hold: permission-controlled override. An active recovery hold
-- is derived from an approved clinical-style rule, so early lifting requires
-- a NAMED medical authority (non-empty) and is audited distinctly as an
-- override. Nothing sets the donor "medically eligible" - the hold ends in
-- administrative terms only.
-- ---------------------------------------------------------------------------
create or replace function public.admin_lift_hold(
  p_donor uuid,
  p_note text,
  p_medical_authority_name text
)
returns table (ok boolean, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  h public.donor_recovery_holds%rowtype;
begin
  if me is null or not exists (select 1 from public.profiles pr where pr.id = me and pr.is_admin) then
    return query select false, 'admin only';
    return;
  end if;
  if nullif(trim(coalesce(p_medical_authority_name,'')), '') is null then
    perform public.append_audit_log('hold.override_refused',
      jsonb_build_object('donor', p_donor, 'reason', 'no medical authority named'), me);
    return query select false, 'overriding a recovery hold requires a named medical authority - refused';
    return;
  end if;
  select * into h from public.donor_recovery_holds where donor_id = p_donor;
  if not found or h.lifted then
    return query select false, 'no active hold';
    return;
  end if;

  update public.donor_recovery_holds
     set lifted = true, lifted_by = me, lifted_by_role = 'admin',
         lifted_note = 'Override by admin; medical authority: ' || trim(p_medical_authority_name) || '; ' || coalesce(p_note, ''),
         lifted_at = now(), updated_at = now()
   where donor_id = p_donor;

  update public.donor_profiles set availability = 'available', paused_until = null, updated_at = now()
   where user_id = p_donor;

  perform public.append_audit_log('hold.override_applied',
    jsonb_build_object('donor', p_donor, 'medical_authority', p_medical_authority_name, 'note', p_note), me);
  return query select true, 'hold overridden by admin (audited)';
end $$;

-- ---------------------------------------------------------------------------
-- Propagation: cancelled/fulfilled/flagged/expired requests stop outreach
-- automatically - every non-terminal match flips to cancelled_with_request.
-- ---------------------------------------------------------------------------
create or replace function public.stop_outreach_on_request_terminal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('cancelled','fulfilled','flagged','expired') then
    update public.request_matches
       set status = 'cancelled_with_request', updated_at = now()
     where request_matches.request_id = new.id
       and request_matches.status not in ('cancelled_with_request','declined','expired');
    perform public.append_audit_log('request.outreach_stopped',
      jsonb_build_object('request_id', new.id, 'status', new.status), null);
  end if;
  return new;
end $$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_outreach_stop_request_terminal') then
    create trigger trg_outreach_stop_request_terminal
      after update of status on public.blood_requests
      for each row
      when (new.status in ('cancelled','fulfilled','flagged','expired'))
      execute function public.stop_outreach_on_request_terminal();
  end if;
end $$;

commit;

-- Least-privilege execute grants (functions default to PUBLIC)
revoke execute on function public.donor_report_donation(date, text, text, text) from anon, public;
revoke execute on function public.donor_confirm_availability() from anon, public;
revoke execute on function public.donor_recovery_state(uuid) from anon, public;
revoke execute on function public.admin_verify_donation(uuid, text, text, text) from anon, public;
revoke execute on function public.admin_set_recovery_rule(text, integer, text, text) from anon, public;
revoke execute on function public.admin_lift_hold(uuid, text, text) from anon, public;
revoke execute on function public.stop_outreach_on_request_terminal() from public;
grant execute on function public.donor_report_donation(date, text, text, text) to authenticated, service_role;
grant execute on function public.donor_confirm_availability() to authenticated, service_role;
grant execute on function public.donor_recovery_state(uuid) to authenticated, service_role;
grant execute on function public.admin_verify_donation(uuid, text, text, text) to authenticated, service_role;
grant execute on function public.admin_set_recovery_rule(text, integer, text, text) to authenticated, service_role;
grant execute on function public.admin_lift_hold(uuid, text, text) to authenticated, service_role;