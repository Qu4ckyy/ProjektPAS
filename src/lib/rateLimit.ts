// Limit ruchu na IP — CONTRACT.md §3, D7, Z23 (kryterium B5). Właściciel: Kamil.
// Liczniki w Mongo (kolekcja rate_limits), więc limit działa także na wielu instancjach Vercela.
import { MongoServerError, type Collection } from "mongodb";
import { getDb } from "@/lib/db";

export type RateLimitBucket = "reservations" | "checkout" | "loyalty"; // [E3] loyalty: saldo i podpowiedź punktów

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export const RATE_LIMITS_COLLECTION = "rate_limits";

export const DEFAULT_RATE_LIMIT_MAX = 40;
export const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 10;

/** Górne granice — absurdalne wartości z env traktujemy jak błąd konfiguracji. */
const MAX_RATE_LIMIT_MAX = 100_000;
const MAX_RATE_LIMIT_WINDOW_SECONDS = 24 * 60 * 60;

/** IP z nagłówka przycinamy — śmieci w nagłówku nie mogą rozdmuchać kluczy w bazie. */
const MAX_IP_LENGTH = 64;

type RateLimitDoc = { _id: string; count: number; expiresAt: Date };

// Ostatnia zła wartość, o której ostrzegliśmy — warning raz, nie przy każdym żądaniu (jak config.ts).
const warnedFor = new Map<string, string>();

function readPositiveInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const trimmed = raw.trim();
  if (/^\d{1,9}$/.test(trimmed)) {
    const value = Number(trimmed);
    if (value >= 1 && value <= max) return value;
  }

  if (warnedFor.get(name) !== raw) {
    warnedFor.set(name, raw);
    console.warn(
      `[rateLimit] ${name}=${JSON.stringify(raw)} jest nieprawidłowe ` +
        `(oczekiwano liczby całkowitej 1–${max}) — używam ${fallback}.`,
    );
  }
  return fallback;
}

/** RATE_LIMIT_MAX: ile żądań na IP w jednym oknie (domyślnie 40). */
export function getRateLimitMax(): number {
  return readPositiveInt("RATE_LIMIT_MAX", DEFAULT_RATE_LIMIT_MAX, MAX_RATE_LIMIT_MAX);
}

/** RATE_LIMIT_WINDOW_SECONDS: długość okna (domyślnie 10 s). */
export function getRateLimitWindowSeconds(): number {
  return readPositiveInt("RATE_LIMIT_WINDOW_SECONDS", DEFAULT_RATE_LIMIT_WINDOW_SECONDS, MAX_RATE_LIMIT_WINDOW_SECONDS);
}

/** Klucz klienta: x-real-ip, potem pierwszy adres z x-forwarded-for, inaczej "local" (§3). */
export function clientIp(req: Request): string {
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp.slice(0, MAX_IP_LENGTH);
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded.slice(0, MAX_IP_LENGTH);
  return "local";
}

type IndexCache = { ttl: Promise<void> | null };

const globalForRateLimit = globalThis as typeof globalThis & { __rateLimitIndexes?: IndexCache };
const indexCache: IndexCache = (globalForRateLimit.__rateLimitIndexes ??= { ttl: null });

/** Indeks TTL — Mongo sam usuwa liczniki po końcu okna. Tworzony raz na proces (jak ensureIndexes). */
function ensureTtlIndexOnce(collection: Collection<RateLimitDoc>): Promise<void> {
  indexCache.ttl ??= collection
    .createIndex({ expiresAt: 1 }, { name: "ttl_expiresAt", expireAfterSeconds: 0 })
    .then(() => undefined)
    .catch((err) => {
      indexCache.ttl = null;
      throw err;
    });
  return indexCache.ttl;
}

async function rateLimitsCollection(): Promise<Collection<RateLimitDoc>> {
  const collection = (await getDb()).collection<RateLimitDoc>(RATE_LIMITS_COLLECTION);
  await ensureTtlIndexOnce(collection);
  return collection;
}

/** Atomowe +1 dla licznika okna. Upsert z warunkiem na _id; przy wyścigu dwóch insertów (E11000) — jeszcze raz. */
async function increment(collection: Collection<RateLimitDoc>, _id: string, expiresAt: Date): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      const doc = await collection.findOneAndUpdate(
        { _id },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
        { upsert: true, returnDocument: "after" },
      );
      return doc?.count ?? 1;
    } catch (err) {
      if (attempt > 0 || !(err instanceof MongoServerError) || err.code !== 11000) throw err;
    }
  }
}

/**
 * Okno stałe: windowStart = floor(teraz / okno), jeden dokument na (bucket, IP, okno).
 * Limit sprawdzamy przed walidacją, więc liczą się też złe żądania (§3).
 * Błąd Mongo → przepuszczamy (fail-open): limit nie może położyć rezerwacji.
 */
export async function rateLimit(req: Request, bucket: RateLimitBucket): Promise<RateLimitResult> {
  const max = getRateLimitMax();
  const windowMs = getRateLimitWindowSeconds() * 1000;
  const ip = clientIp(req);
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs);
  const windowEnd = (windowStart + 1) * windowMs;

  let count: number;
  try {
    const collection = await rateLimitsCollection();
    count = await increment(collection, `${bucket}:${ip}:${windowStart}`, new Date(windowEnd));
  } catch (err) {
    console.error(`[rateLimit] Nie udało się policzyć żądania (${bucket}) — przepuszczam:`, err);
    return { ok: true };
  }

  if (count <= max) return { ok: true };
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - now) / 1000)) };
}
