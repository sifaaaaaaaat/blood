import "server-only";
import { z } from "zod";
import type { AuthUser } from "@/src/lib/auth";

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
const err = (code: string, message: string): Result<never> => ({ ok: false, code, message });

type DbError = { message: string } | null;
type Row = Record<string, unknown>;
type QueryResult = { data: unknown; error: DbError };

/**
 * Phase 11H — content + contact intake.
 *
 *  · content: ONLY admin-authored, approved copy (published or draft since
 *    their own); the public pages show published items per category.
 *  · contact: visitor messages are stored for admin reading — never displayed
 *    publicly, no SELECT policy even exists on the table.
 */

export const CATEGORIES = ["faq", "blog", "guide"] as const;
export type ContentCategory = (typeof CATEGORIES)[number];
export function isCategory(v: string | undefined | null): v is ContentCategory {
  return (CATEGORIES as readonly string[]).includes(v ?? "");
}

export type Article = {
  id: string;
  slug: string;
  title: string;
  titleBn: string | null;
  body: string;
  bodyBn: string | null;
  publishedAt: string | null;
};

const COLS = "id, slug, title, title_bn, body, body_bn, published_at";

function mapArticle(row: Row): Article {
  return {
    id: String(row["id"]),
    slug: String(row["slug"]),
    title: String(row["title"]),
    titleBn: (row["title_bn"] as string) ?? null,
    body: String(row["body"]),
    bodyBn: (row["body_bn"] as string) ?? null,
    publishedAt: (row["published_at"] as string) ?? null,
  };
}

type Chain = {
  select(cols?: string): {
    eq(c: string, v: string | boolean): ChainEq;
    order(c: string, o?: { ascending?: boolean }): { limit(n: number): PromiseLike<QueryResult> };
    limit(n: number): PromiseLike<QueryResult>;
  };
  eq(c: string, v: string | boolean): ChainEq;
  order(c: string, o?: { ascending?: boolean }): { limit(n: number): PromiseLike<QueryResult> };
  insert(v: unknown): PromiseLike<QueryResult>;
  limit(n: number): PromiseLike<QueryResult>;
  maybeSingle(): PromiseLike<QueryResult>;
};
type ChainEq = {
  eq(c2: string, v2: string | boolean): {
    order(c: string, o?: { ascending?: boolean }): { limit(n: number): PromiseLike<QueryResult> };
    limit(n: number): PromiseLike<QueryResult>;
  };
  limit(n: number): PromiseLike<QueryResult>;
};
type ClientLike = {
  from(t: string): Chain;
  rpc(fn: string, args?: Record<string, unknown>): Promise<QueryResult>;
};

async function getService(): Promise<ClientLike> {
  const { getServiceRoleClient } = await import("@/src/lib/db");
  return getServiceRoleClient() as unknown as ClientLike;
}
async function getAuthed(): Promise<ClientLike> {
  const { createAuthedClient } = await import("@/src/lib/db");
  return (await createAuthedClient()) as unknown as ClientLike;
}

/** Published articles of one category, newest first (public surface). */
export async function listPublished(category: ContentCategory, limit = 50): Promise<Result<Article[]>> {
  const svc = await getService();
  const { data, error } = await svc
    .from("content_items")
    .select(COLS)
    .eq("is_published", true)
    .eq("category", category)
    .order("published_at", { ascending: false })
    .limit(limit);
  if (error) return err("db_error", error!.message);
  return { ok: true, data: ((data ?? []) as Row[]).map(mapArticle) };
}

/** One published article by slug (title route for faqs/[slug] etc.). */
export async function getPublishedBySlug(
  category: ContentCategory,
  slug: string | undefined
): Promise<Result<Article>> {
  if (!slug || !/^[a-z0-9-]{3,120}$/.test(slug)) return err("validation_error", "invalid slug");
  const svc = await getService();
  const { data, error } = await svc
    .from("content_items")
    .select(COLS)
    .eq("is_published", true)
    .eq("category", category)
    .limit(200);
  if (error) return err("db_error", error!.message);
  const match = ((data ?? []) as Row[])
    .filter((r) => String(r["slug"]) === slug)
    .map(mapArticle)[0];
  if (!match) return err("not_found", "article not found");
  return { ok: true, data: match };
}

const contentUpsertSchema = z
  .object({
    id: z.string().uuid().optional(),
    category: z.enum(CATEGORIES),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]{3,120}$/, "slug must be lowercase kebab-case"),
    title: z.string().trim().min(2).max(200),
    title_bn: z.string().trim().max(200).optional(),
    body: z.string().trim().min(2).max(20000),
    body_bn: z.string().trim().max(20000).optional(),
    is_published: z.boolean().default(false),
  })
  .strict();

/** Admin create/update via the DB-reverified RPC (app-level check first). */
export async function adminUpsertContent(auth: AuthUser, input: unknown): Promise<Result<Article>> {
  if (!auth.isAdmin) return err("forbidden", "admin only");
  const parsed = contentUpsertSchema.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return err("validation_error", i.message);
  }
  const v = parsed.data;
  const client = await getAuthed();
  const { data, error } = (await client
    .rpc("admin_content_upsert", {
      p_id: v.id ?? null,
      p_category: v.category,
      p_slug: v.slug,
      p_title: v.title,
      p_title_bn: v.title_bn ?? null,
      p_body: v.body,
      p_body_bn: v.body_bn ?? null,
      p_is_published: v.is_published,
    })) as unknown as { data: Row | null; error: DbError };
  if (error) {
    const msg = (error?.message ?? "").toLowerCase();
    if (msg.startsWith("admin only")) return err("forbidden", error!.message!);
    return err("db_error", error!.message!);
  }
  return { ok: true, data: mapArticle((data ?? {}) as Row) };
}

/** Admin list of all content (draft + published, app-level pre-check). */
export async function adminListContent(auth: AuthUser): Promise<Result<Row[]>> {
  if (!auth.isAdmin) return err("forbidden", "admin only");
  const svc = await getService();
  const { data, error } = await svc
    .from("content_items")
    .select("id, category, slug, title, is_published, published_at, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return err("db_error", error!.message);
  return { ok: true, data: (data ?? []) as Row[] };
}

// ---------------------------------------------------------------------------
// Contact intake (private)
// ---------------------------------------------------------------------------

export const contactMessageSchema = z
  .object({
    name: z.string().trim().max(120).default(""),
    email: z.string().trim().email().max(200),
    message: z.string().trim().min(2).max(4000),
    consent: z.boolean(),
  })
  .strict()
  .refine((v) => v.email.length <= 200, { message: "email too long", path: ["email"] });

export type ContactMessage = z.infer<typeof contactMessageSchema>;

const WINDOW_MS = 10 * 60 * 1000;
const CONTACT_RATE_LIMIT = 5; // messages per rolling window
const contactBuckets = new Map<string, number[]>();

/** Simple rolling-window cap keyed by the (pseudo-)client identity. */
export function checkContactRate(key: string): boolean {
  const now = Date.now();
  const arr = (contactBuckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= CONTACT_RATE_LIMIT) return false;
  arr.push(now);
  contactBuckets.set(key, arr);
  return true;
}

/** Store a visitor message via service role (private table, admin-read only). */
export async function storeContactMessage(input: ContactMessage): Promise<Result<{ stored: true }>> {
  const svc = await getService();
  const { error } = await (svc as unknown as {
    from(t: string): {
      insert(v: unknown): PromiseLike<QueryResult>;
    };
  }).from("contact_messages").insert({
    name: input.name,
    email: input.email,
    message: input.message,
    consent: input.consent,
  });
  if (error) return err("db_error", error!.message);
  return { ok: true, data: { stored: true } };
}

/** Admin contact inbox (app-level pre-check; service-role read). */
export async function adminListContactMessages(auth: AuthUser): Promise<Result<Row[]>> {
  if (!auth.isAdmin) return err("forbidden", "admin only");
  const svc = await getService();
  const { data, error } = await svc
    .from("contact_messages")
    .select("id, name, email, message, consent, handled_at, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return err("db_error", error!.message);
  return { ok: true, data: (data ?? []) as Row[] };
}
