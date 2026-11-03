// Limit ruchu (karta A, Kamil) — CONTRACT.md §3, D7, Z23, kryterium B5.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as checkoutRoute } from "@/app/api/reservations/[id]/checkout/route";
import { POST as createRoute } from "@/app/api/reservations/route";
import { closeDb, getDb } from "@/lib/db";
import {
  clientIp,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  getRateLimitMax,
  getRateLimitWindowSeconds,
  rateLimit,
  RATE_LIMITS_COLLECTION,
} from "@/lib/rateLimit";

// getDb przez vi.fn — w teście fail-open podmieniamy jedno wywołanie na błąd.
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: vi.fn(actual.getDb) };
});

const WINDOW_MS = DEFAULT_RATE_LIMIT_WINDOW_SECONDS * 1000;
const BASE = "http://localhost:3000";

let ipCounter = 0;
/** Każdy test dostaje własne IP, żeby liczniki się nie mieszały. */
function nextIp(): string {
  ipCounter++;
  return `203.0.113.${ipCounter}`;
}

function req(headers: Record<string, string> = {}, path = "/api/reservations", body?: string): Request {
  return new Request(`${BASE}${path}`, { method: "POST", headers, body });
}

/** Zatrzymuje Date w przyszłym oknie, offsetMs od jego początku — wiadomo, ile zostało do końca. Zwraca początek okna. */
function freezeAtWindowOffset(offsetMs: number): number {
  const windowStart = Math.ceil(Date.now() / WINDOW_MS) * WINDOW_MS + WINDOW_MS;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(windowStart + offsetMs);
  return windowStart;
}

async function rateLimitsCollection() {
  const db = await getDb();
  if (db.databaseName !== "pociag_test") throw new Error(`Testy tylko na pociag_test, nie ${db.databaseName}.`);
  return db.collection(RATE_LIMITS_COLLECTION);
}

beforeEach(async () => {
  process.env.RATE_LIMIT_MAX = "40";
  process.env.RATE_LIMIT_WINDOW_SECONDS = "10";
  await (await rateLimitsCollection()).deleteMany({});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(async () => {
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.RATE_LIMIT_WINDOW_SECONDS;
  await closeDb();
});

describe("rateLimit()", () => {
  it("40 żądań w oknie przechodzi, 41. → 429 z retryAfter do końca okna", async () => {
    freezeAtWindowOffset(3_000);
    const ip = nextIp();
    for (let i = 0; i < 40; i++) {
      expect(await rateLimit(req({ "x-real-ip": ip }), "reservations")).toEqual({ ok: true });
    }
    expect(await rateLimit(req({ "x-real-ip": ip }), "reservations")).toEqual({ ok: false, retryAfterSeconds: 7 });
  });

  it("retryAfter co najmniej 1 s, nawet tuż przed końcem okna", async () => {
    freezeAtWindowOffset(WINDOW_MS - 50);
    process.env.RATE_LIMIT_MAX = "1";
    const ip = nextIp();
    await rateLimit(req({ "x-real-ip": ip }), "reservations");
    expect(await rateLimit(req({ "x-real-ip": ip }), "reservations")).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  it("inne IP liczone niezależnie", async () => {
    freezeAtWindowOffset(1_000);
    const flooder = nextIp();
    for (let i = 0; i < 41; i++) await rateLimit(req({ "x-real-ip": flooder }), "reservations");
    expect((await rateLimit(req({ "x-real-ip": flooder }), "reservations")).ok).toBe(false);
    expect(await rateLimit(req({ "x-real-ip": nextIp() }), "reservations")).toEqual({ ok: true });
  });

  it("bucket checkout liczony osobno od reservations", async () => {
    freezeAtWindowOffset(1_000);
    const ip = nextIp();
    for (let i = 0; i < 41; i++) await rateLimit(req({ "x-real-ip": ip }), "reservations");
    expect(await rateLimit(req({ "x-real-ip": ip }), "checkout")).toEqual({ ok: true });
  });

  it("nowe okno resetuje licznik", async () => {
    const windowStart = freezeAtWindowOffset(9_000);
    const ip = nextIp();
    for (let i = 0; i < 40; i++) await rateLimit(req({ "x-real-ip": ip }), "reservations");
    expect((await rateLimit(req({ "x-real-ip": ip }), "reservations")).ok).toBe(false);

    vi.setSystemTime(windowStart + WINDOW_MS + 1);
    expect(await rateLimit(req({ "x-real-ip": ip }), "reservations")).toEqual({ ok: true });
  });

  it("60 równoległych żądań z jednego IP → dokładnie 40 przepuszczonych (atomowy licznik)", async () => {
    freezeAtWindowOffset(1_000);
    const ip = nextIp();
    const results = await Promise.all(
      Array.from({ length: 60 }, () => rateLimit(req({ "x-real-ip": ip }), "reservations")),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(40);
    expect(results.filter((r) => !r.ok)).toHaveLength(20);
  });

  it("licznik w rate_limits: _id bucket:ip:okno, expiresAt = koniec okna (indeks TTL)", async () => {
    const windowStart = freezeAtWindowOffset(2_000);
    const ip = nextIp();
    await rateLimit(req({ "x-real-ip": ip }), "checkout");
    await rateLimit(req({ "x-real-ip": ip }), "checkout");

    const collection = await rateLimitsCollection();
    const doc = await collection.findOne({ _id: `checkout:${ip}:${windowStart / WINDOW_MS}` as never });
    expect(doc).toMatchObject({ count: 2, expiresAt: new Date(windowStart + WINDOW_MS) });
    const indexes = await collection.indexes();
    expect(indexes).toContainEqual(expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }));
  });

  it("błąd Mongo → żądanie przepuszczone (fail-open) i zalogowane", async () => {
    const { getDb: mockedGetDb } = await import("@/lib/db");
    vi.mocked(mockedGetDb).mockRejectedValueOnce(new Error("Mongo niedostępne"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await rateLimit(req({ "x-real-ip": nextIp() }), "reservations")).toEqual({ ok: true });
    expect(errorLog).toHaveBeenCalled();
  });
});

describe("clientIp()", () => {
  it("x-real-ip ma pierwszeństwo przed x-forwarded-for", () => {
    expect(clientIp(req({ "x-real-ip": " 198.51.100.7 ", "x-forwarded-for": "10.0.0.1" }))).toBe("198.51.100.7");
  });

  it("pierwszy adres z x-forwarded-for", () => {
    expect(clientIp(req({ "x-forwarded-for": " 198.51.100.8 , 10.0.0.1, 10.0.0.2" }))).toBe("198.51.100.8");
  });

  it("brak nagłówków → local", () => {
    expect(clientIp(req())).toBe("local");
    expect(clientIp(req({ "x-forwarded-for": " , " }))).toBe("local");
  });

  it("bardzo długi nagłówek przycięty do 64 znaków", () => {
    expect(clientIp(req({ "x-real-ip": "a".repeat(10_000) }))).toHaveLength(64);
  });
});

describe("konfiguracja z env", () => {
  it("domyślnie 40 / 10", () => {
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW_SECONDS;
    expect(getRateLimitMax()).toBe(DEFAULT_RATE_LIMIT_MAX);
    expect(getRateLimitWindowSeconds()).toBe(DEFAULT_RATE_LIMIT_WINDOW_SECONDS);
  });

  it("poprawne wartości z env", () => {
    process.env.RATE_LIMIT_MAX = " 100 ";
    process.env.RATE_LIMIT_WINDOW_SECONDS = "60";
    expect(getRateLimitMax()).toBe(100);
    expect(getRateLimitWindowSeconds()).toBe(60);
  });

  it.each(["0", "-5", "abc", "1.5", "1e3", "99999999999"])("zła wartość %j → domyślna + ostrzeżenie", (raw) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.RATE_LIMIT_MAX = raw;
    process.env.RATE_LIMIT_WINDOW_SECONDS = raw;
    expect(getRateLimitMax()).toBe(DEFAULT_RATE_LIMIT_MAX);
    expect(getRateLimitWindowSeconds()).toBe(DEFAULT_RATE_LIMIT_WINDOW_SECONDS);
    expect(warn).toHaveBeenCalled();
  });
});

describe("kryterium B5 przez HTTP", () => {
  it("POST /api/reservations: 41. żądanie z jednego IP → 429 RATE_LIMITED + Retry-After; limit przed walidacją", async () => {
    freezeAtWindowOffset(4_000);
    const ip = nextIp();
    // Śmieciowe body — limit liczy też złe żądania (§3).
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await createRoute(req({ "x-real-ip": ip }, "/api/reservations", "{"))).status);
    expect(new Set(statuses)).toEqual(new Set([400]));

    const res = await createRoute(req({ "x-real-ip": ip }, "/api/reservations", "{"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("6");
    expect(await res.json()).toEqual({ error: "RATE_LIMITED", message: expect.stringContaining("6 s") });

    // Drugi klient z innego IP nie jest blokowany.
    expect((await createRoute(req({ "x-real-ip": nextIp() }, "/api/reservations", "{"))).status).toBe(400);
  });

  it("POST /api/reservations/:id/checkout: 41. żądanie → 429 zanim cokolwiek innego", async () => {
    freezeAtWindowOffset(1_000);
    const ip = nextIp();
    const ctx = { params: Promise.resolve({ id: "abc" }) };
    for (let i = 0; i < 40; i++) {
      expect((await checkoutRoute(req({ "x-real-ip": ip }, "/api/reservations/abc/checkout"), ctx)).status).toBe(404);
    }
    const res = await checkoutRoute(req({ "x-real-ip": ip }, "/api/reservations/abc/checkout"), ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("9");
  });
});
