-- ============================================================================
-- Phase 7: notification outbox + attempts audit
--
-- Durability & privacy rules:
--  · idempotency_key UNIQUE — enqueue is a no-op for duplicates (dedupe).
--  · recipient phone stored ONLY as operational data in the outbox row for
--    real providers; message content itself is NEVER persisted (only the
--    message_type + sanitized failure_reason).
--  · simulated providers can never set a row to a real-delivery status.
--  · server-only tables: RLS on, no policies => invisible to anon/authenticated.
-- ============================================================================

begin;

do $$ begin
  if not exists (select 1 from pg_type where typname='outbox_status' and typnamespace='public'::regnamespace) then
    create type public.outbox_status as enum (
      'queued', 'sending', 'simulated_sent', 'delivered',
      'failed', 'expired', 'skipped_consent', 'skipped_cancelled'
    );
  end if;
end $$;

create table if not exists public.notification_outbox (
  id                uuid primary key default gen_random_uuid(),
  idempotency_key   text not null unique,
  request_id        uuid references public.blood_requests(id) on delete set null,
  recipient_id      uuid references public.profiles(id) on delete set null,
  recipient_phone   text,                    -- E.164, operational data only
  provider          text not null default 'mock',
  message_type      text not null,
  status            public.outbox_status not null default 'queued',
  attempts          integer not null default 0,
  provider_ref      text,                    -- provider message id when known
  failure_reason    text,                    -- sanitized: no content, no PII
  simulated         boolean not null default false,
  created_at        timestamptz not null default now(),
  available_after   timestamptz not null default now(),   -- next-try time
  completed_at      timestamptz,
  expires_at        timestamptz not null default now() + interval '6 hours'
);

create index if not exists outbox_due_idx
  on public.notification_outbox (available_after)
  where status = 'queued';
create index if not exists outbox_recipient_idx
  on public.notification_outbox (recipient_id)
  where status in ('queued','sending');
create index if not exists outbox_request_idx
  on public.notification_outbox (request_id, status);

-- Append-only attempts audit: one row per send attempt (simulated or real).
create table if not exists public.notification_attempts (
  id            uuid primary key default gen_random_uuid(),
  outbox_id     uuid not null references public.notification_outbox(id) on delete cascade,
  attempt_no    integer not null,
  provider      text not null,
  simulated     boolean not null default false,
  outcome       text not null,               -- 'accepted' | 'failed'
  failure_reason text,                       -- sanitized
  created_at    timestamptz not null default now()
);

-- Server-only surfaces: RLS on, zero policies => visible to service role only
-- (same pattern as upazila_geo).
alter table public.notification_outbox enable row level security;
alter table public.notification_attempts enable row level security;
revoke all on public.notification_outbox from anon, authenticated;
revoke all on public.notification_attempts from anon, authenticated;

commit;
