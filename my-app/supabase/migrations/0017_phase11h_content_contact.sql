-- Phase 11H: content (FAQs / articles / donation guide) and contact intake.
--
--   · content_items  — admin-authored, approved-copy articles. Categories:
--                      'faq' | 'blog' | 'guide'. Public surface = published,
--                      newest first; nothing is ever invented.
--   · contact_messages — visitor intake; only platform admins read them.
--
create table if not exists public.content_items (
  id            uuid primary key default gen_random_uuid(),
  category      text not null check (category in ('faq','blog','guide')),
  slug          text not null unique check (slug ~ '^[a-z0-9-]{3,120}$'),
  title         text not null check (length(title) between 2 and 200),
  title_bn      text,
  body          text not null check (length(body) between 2 and 20000),
  body_bn       text,
  is_published  boolean not null default false,
  published_at  timestamptz,
  author_id     uuid references public.profiles (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists content_items_public_idx
  on public.content_items (category, published_at desc) where is_published;

alter table public.content_items enable row level security;

do $$ begin
if not exists (select 1 from pg_policies where tablename='content_items' and policyname='content_items_public_select') then
  create policy content_items_public_select on public.content_items
    for select using (
      is_published
      or author_id = auth.uid()
      or (select is_admin from public.profiles where id = auth.uid())
    );
end if;
end $$;

-- Admin upsert re-verifying the platform admin role inside Postgres.
create or replace function public.admin_content_upsert(
  -- Required params first: Postgres forbids non-defaulted params after one
  -- with a default (callers use named arguments, so order is cosmetic).
  p_category    text,
  p_slug        text,
  p_title       text,
  p_body        text,
  p_id          uuid default null,
  p_title_bn    text default null,
  p_body_bn     text default null,
  p_is_published boolean default false
) returns public.content_items
language plpgsql security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_admin boolean;
  v_row   public.content_items;
begin
  if v_user is null then raise exception 'not signed in'; end if;
  select is_admin into v_admin from public.profiles where id = v_user;
  if not coalesce(v_admin, false) then raise exception 'admin only'; end if;

  if p_id is null then
    insert into public.content_items (category, slug, title, title_bn, body, body_bn, is_published, published_at, author_id)
    values (p_category, p_slug, p_title, p_title_bn, p_body, p_body_bn, p_is_published,
            case when p_is_published then now() else null end, v_user)
    returning * into v_row;
  else
    update public.content_items set
      category = p_category, slug = p_slug, title = p_title, title_bn = p_title_bn,
      body = p_body, body_bn = p_body_bn, is_published = p_is_published,
      published_at = case when p_is_published and published_at is null then now() when p_is_published then published_at else null end,
      author_id = coalesce(author_id, v_user), updated_at = now()
    where id = p_id
    returning * into v_row;
  end if;
  if not found then raise exception 'content item not found'; end if;
  return v_row;
end $$;

-- Visitor contact intake — private by design: no public SELECT policy at all.
create table if not exists public.contact_messages (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default '' check (length(name) <= 120),
  email       text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  message     text not null check (length(message) between 2 and 4000),
  consent     boolean not null default false,
  handled_at  timestamptz,
  created_at  timestamptz not null default now()
);

alter table public.contact_messages enable row level security;
-- Inserts happen through the service-role API route (validated + rate-capped
-- server-side); admins read via the admin route. No direct-to-table path.
