// Route handlery wywoływane jak z sieci (new Request) — kody HTTP i kształty z CONTRACT.md §3, §4.
import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { closeDb } from "@/lib/db";
import { TICKET_CODE_REGEX } from "@/lib/types";
import {
  apiCreate,
  apiGetEvent,
  apiGetReservation,
  apiGetTicket,
  apiPurchase,
  DEPARTED_EVENT,
  FUTURE_EVENT,
  reservationsCollection,
  resetTestData,
  setTtl,
  SHORT_TTL_SECONDS,
  validBody,
  waitForExpiry,
  type ApiResult,
} from "./helpers";

const HEX_ID = /^[0-9a-f]{24}$/;

/** Ślady stack trace, nazwy sterownika, ścieżki plików — nic z tego nie może wyjść w odpowiedzi (Z12). */
const LEAK = /\bat .+\(|Error:|Mongo|node_modules|\/src\/|\.ts:\d/;

function expectError(res: ApiResult, status: number, error: string): void {
  expect(res.status, res.text).toBe(status);
  expect(res.body).toEqual({ error, message: expect.any(String) });
  expect((res.body as { message: string }).message.length).toBeGreaterThan(0);
  expect(res.text).not.toMatch(LEAK);
}

function expectIso(value: unknown): void {
  expect(typeof value).toBe("string");
  expect(new Date(value as string).toISOString()).toBe(value);
}

async function reserve(seatId: string): Promise<string> {
  const res = await apiCreate(validBody({ seatId }));
  expect(res.status, res.text).toBe(201);
  return (res.body as { reservationId: string }).reservationId;
}

async function buy(id: string): Promise<string> {
  const res = await apiPurchase(id);
  expect(res.status, res.text).toBe(200);
  return (res.body as { code: string }).code;
}

beforeAll(resetTestData);
beforeEach(async () => {
  setTtl(120);
  await (await reservationsCollection()).deleteMany({});
});
afterAll(async () => {
  setTtl(undefined);
  await closeDb();
});

describe("POST /api/reservations", () => {
  it("201 { reservationId, expiresAt } — dokładnie te pola, expiresAt = teraz + TTL", async () => {
    const before = Date.now();
    const res = await apiCreate(validBody({ seatId: "2-14" }));

    expect(res.status).toBe(201);
    expect(Object.keys(res.body as object).sort()).toEqual(["expiresAt", "reservationId"]);
    const body = res.body as { reservationId: string; expiresAt: string };
    expect(body.reservationId).toMatch(HEX_ID);
    expectIso(body.expiresAt);
    const ttlMs = new Date(body.expiresAt).getTime() - before;
    expect(ttlMs).toBeGreaterThanOrEqual(120_000);
    expect(ttlMs).toBeLessThan(125_000);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("dodatkowe pola są ignorowane i nie trafiają do bazy", async () => {
    const json = JSON.stringify(
      validBody({
        seatId: "2-15",
        status: "purchased",
        active: false,
        code: "AAAA-AAAA",
        expiresAt: "2099-01-01T00:00:00.000Z",
        _id: "0123456789abcdef01234567",
        admin: true,
      }),
    );
    // __proto__ jako zwykły klucz JSON (literał obiektu w JS ustawiłby prototyp, a nie pole).
    const res = await apiCreate(json.replace(/}$/, ',"__proto__":{"polluted":true}}'));
    expect(res.status).toBe(201);
    const doc = await (await reservationsCollection()).findOne({
      _id: new ObjectId((res.body as { reservationId: string }).reservationId),
    });
    expect(doc).toMatchObject({ status: "held", active: true, code: null });
    expect(doc).not.toHaveProperty("admin");
    expect(doc).not.toHaveProperty("polluted");
    expect(doc!.expiresAt.getFullYear()).toBeLessThan(2099);
  });

  it("trim pól przed zapisem", async () => {
    const res = await apiCreate(validBody({ eventId: ` ${FUTURE_EVENT._id} `, seatId: " 1-1 ", customerName: "  Anna  " }));
    expect(res.status).toBe(201);
    const doc = await (await reservationsCollection()).findOne({ seatId: "1-1" });
    expect(doc).toMatchObject({ eventId: FUTURE_EVENT._id, customerName: "Anna" });
  });

  const ok = JSON.stringify(validBody());
  const garbage: [string, unknown][] = [
    ["brak body", undefined],
    ["puste body", ""],
    ["nie-JSON", "nie-json"],
    ["ucięty JSON", ok.slice(0, -1)],
    ["form-urlencoded", "eventId=test-future&seatId=1-1"],
    ["tablica", "[]"],
    ["tablica z obiektem", `[${ok}]`],
    ["null", "null"],
    ["liczba", "123"],
    ["string", '"tekst"'],
    ["true", "true"],
    ["pusty obiekt", "{}"],
    ["eventId jako liczba", validBody({ eventId: 1 })],
    ["seatId jako tablica", validBody({ seatId: ["1-1"] })],
    ["customerName jako obiekt", validBody({ customerName: { first: "Jan" } })],
    ["email jako null", validBody({ email: null })],
    ["eventId {$ne: null}", validBody({ eventId: { $ne: null } })],
    ["seatId {$gt: ''}", validBody({ seatId: { $gt: "" } })],
    ["wszystkie pola {$ne: null}", { eventId: { $ne: null }, seatId: { $ne: null }, customerName: { $ne: null }, email: { $ne: null } }],
    ["brak eventId", validBody({ eventId: undefined })],
    ["brak email", validBody({ email: undefined })],
    ["customerName pusty po trim", validBody({ customerName: "   " })],
    ["customerName 101 znaków", validBody({ customerName: "x".repeat(101) })],
    ["customerName 10 000 znaków", validBody({ customerName: "x".repeat(10_000) })],
    ["eventId 5000 znaków", validBody({ eventId: "e".repeat(5000) })],
    ["seatId 101 znaków", validBody({ seatId: "1".repeat(101) })],
    ["zły e-mail", validBody({ email: "to-nie-email" })],
    ["e-mail 300 znaków", validBody({ email: `${"a".repeat(290)}@example.com` })],
    ["body 1 MB", validBody({ customerName: "x".repeat(1024 * 1024) })],
    ["body 1 MB śmieci", "x".repeat(1024 * 1024)],
    ["niepoprawne UTF-8", new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])],
  ];

  it.each(garbage)("Z6: %s → 400 VALIDATION_ERROR", async (_name, body) => {
    expectError(await apiCreate(body), 400, "VALIDATION_ERROR");
  });

  it("Z6: żadne śmieci nie zapisały rezerwacji", async () => {
    await Promise.all(garbage.map(([, body]) => apiCreate(body)));
    expect(await (await reservationsCollection()).countDocuments()).toBe(0);
  });

  it("Z8: nieistniejący kurs → 404 EVENT_NOT_FOUND", async () => {
    expectError(await apiCreate(validBody({ eventId: "nie-ma-takiego-kursu" })), 404, "EVENT_NOT_FOUND");
  });

  it.each(["9-99", "1-21", "abc"])("Z8: miejsce %s → 400 INVALID_SEAT", async (seatId) => {
    expectError(await apiCreate(validBody({ seatId })), 400, "INVALID_SEAT");
  });

  it("Z9: kurs odjechał → 409 EVENT_DEPARTED", async () => {
    expectError(await apiCreate(validBody({ eventId: DEPARTED_EVENT._id })), 409, "EVENT_DEPARTED");
  });

  it("Z1: 50 równoległych żądań na to samo miejsce → 1× 201, 49× 409 SEAT_TAKEN, 0× 500", async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => apiCreate(validBody({ seatId: "1-7" }))));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    const conflicts = results.filter((r) => r.status === 409);
    expect(conflicts).toHaveLength(49);
    for (const res of conflicts) expectError(res, 409, "SEAT_TAKEN");

    // Kamil: GET /api/events/:id widzi miejsce jako zajęte.
    const event = await apiGetEvent(FUTURE_EVENT._id);
    expect((event.body as { takenSeats: string[] }).takenSeats).toEqual(["1-7"]);
  });
});

describe("POST /api/reservations/:id/purchase", () => {
  it("200 { code } — dokładnie to pole, format XXXX-XXXX", async () => {
    const id = await reserve("1-1");
    const res = await apiPurchase(id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ code: expect.stringMatching(TICKET_CODE_REGEX) });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("ignoruje body (także śmieciowe i z polami do podmiany)", async () => {
    const id = await reserve("1-2");
    const res = await apiPurchase(id, JSON.stringify({ code: "AAAA-AAAA", status: "held", eventId: "x" }));
    expect(res.status).toBe(200);
    const doc = await (await reservationsCollection()).findOne({ _id: new ObjectId(id) });
    expect(doc).toMatchObject({ status: "purchased", code: (res.body as { code: string }).code, eventId: FUTURE_EVENT._id });
    expect((await apiPurchase(id, "nie-json")).status).toBe(200);
  });

  it("Z4: ponowny zakup → 200 z tym samym kodem", async () => {
    const id = await reserve("1-3");
    const code = await buy(id);
    expect(await buy(id)).toBe(code);
  });

  it("Z4: 10 równoległych zakupów → 10× 200 z jednym kodem", async () => {
    const id = await reserve("1-4");
    const results = await Promise.all(Array.from({ length: 10 }, () => apiPurchase(id)));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(new Set(results.map((r) => (r.body as { code: string }).code)).size).toBe(1);
  });

  it("Z3: zakup po TTL → 410 RESERVATION_EXPIRED, miejsce wraca do puli", async () => {
    setTtl(SHORT_TTL_SECONDS);
    const id = await reserve("1-5");
    await waitForExpiry();

    expectError(await apiPurchase(id), 410, "RESERVATION_EXPIRED");
    expectError(await apiPurchase(id), 410, "RESERVATION_EXPIRED");
    expect((await apiGetReservation(id)).body).toMatchObject({ status: "expired" });
    expect((await apiGetEvent(FUTURE_EVENT._id)).body).toMatchObject({ takenSeats: [] });
    setTtl(120);
    expect((await apiCreate(validBody({ seatId: "1-5" }))).status).toBe(201);
  });

  it("Z5: kupione miejsce zostaje zajęte po TTL", async () => {
    setTtl(SHORT_TTL_SECONDS);
    const id = await reserve("1-6");
    const code = await buy(id);
    await waitForExpiry();

    expect((await apiGetEvent(FUTURE_EVENT._id)).body).toMatchObject({ takenSeats: ["1-6"] });
    expectError(await apiCreate(validBody({ seatId: "1-6" })), 409, "SEAT_TAKEN");
    expect(await buy(id)).toBe(code);
    expect((await apiGetReservation(id)).body).toMatchObject({ status: "purchased", code });
  });

  it.each([
    ["abc", "abc"],
    ["{} (zdekodowane %7B%7D)", "{}"],
    ["%7B%7D", "%7B%7D"],
    ["12 znaków (ObjectId.isValid = true)", "aaaaaaaaaaaa"],
    ["10 000 znaków", "a".repeat(10_000)],
    ["24 hex wielkimi literami", "A".repeat(24)],
    ["24 znaki nie-hex", "z".repeat(24)],
    ["poprawny format, brak w bazie", "0123456789abcdef01234567"],
  ])("Z7: id %s → 404 RESERVATION_NOT_FOUND", async (_name, id) => {
    expectError(await apiPurchase(id), 404, "RESERVATION_NOT_FOUND");
  });
});

describe("GET /api/reservations/:id", () => {
  it("held: dokładne pola z kontraktu, bez e-maila i bez kodu", async () => {
    const id = await reserve("2-1");
    const doc = await (await reservationsCollection()).findOne({ _id: new ObjectId(id) });

    const res = await apiGetReservation(id);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body as object).sort()).toEqual(
      ["customerName", "event", "eventId", "expiresAt", "reservationId", "seatId", "serverNow", "status"].sort(),
    );
    expect(res.body).toMatchObject({ reservationId: id, eventId: FUTURE_EVENT._id, seatId: "2-1", status: "held" });
    expect((res.body as { event: unknown }).event).toEqual(FUTURE_EVENT);
    expectIso((res.body as { expiresAt: string }).expiresAt);
    expectIso((res.body as { serverNow: string }).serverNow);
    expect(Math.abs(new Date((res.body as { serverNow: string }).serverNow).getTime() - Date.now())).toBeLessThan(5_000);

    // Z11: e-mail nie pojawia się nigdzie w odpowiedzi.
    expect(res.text).not.toContain("email");
    expect(res.text).not.toContain(doc!.email);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("purchased: status purchased i code", async () => {
    const id = await reserve("2-2");
    const code = await buy(id);
    const res = await apiGetReservation(id);
    expect(res.body).toMatchObject({ status: "purchased", code });
    expect(res.text).not.toContain("@example.com");
  });

  it("held po TTL → status expired", async () => {
    setTtl(SHORT_TTL_SECONDS);
    const id = await reserve("2-3");
    await waitForExpiry();
    const res = await apiGetReservation(id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "expired" });
    expect(res.body).not.toHaveProperty("code");
  });

  it.each(["abc", "{}", "%7B%7D", "aaaaaaaaaaaa", "a".repeat(10_000), "A".repeat(24), new ObjectId().toHexString()])(
    "Z7: id %s → 404 RESERVATION_NOT_FOUND",
    async (id) => {
      expectError(await apiGetReservation(id), 404, "RESERVATION_NOT_FOUND");
    },
  );
});

describe("GET /api/tickets/:code", () => {
  it("kupiony bilet: dokładne pola, bez e-maila; kod małymi literami i ze spacjami też działa", async () => {
    const id = await reserve("2-4");
    const code = await buy(id);

    for (const variant of [code, code.toLowerCase(), ` ${code} `]) {
      const res = await apiGetTicket(variant);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body as object).sort()).toEqual(["code", "customerName", "event", "purchasedAt", "seatId"]);
      expect(res.body).toMatchObject({ code, seatId: "2-4" });
      expect((res.body as { event: unknown }).event).toEqual(FUTURE_EVENT);
      expectIso((res.body as { purchasedAt: string }).purchasedAt);
      expect(res.text).not.toContain("email");
      expect(res.text).not.toContain("@example.com");
    }
  });

  it("rezerwacja held nie ma biletu", async () => {
    await reserve("2-5");
    const codes = await (await reservationsCollection()).distinct("code");
    expect(codes).toEqual([null]);
    expectError(await apiGetTicket("ABCD-EFGH"), 404, "TICKET_NOT_FOUND");
  });

  it.each(["ABCD-EFGH", "abcd", "ABCDEFGH", "ABCD-EFG0", "%7B%7D", "{}", "A".repeat(10_000), "0123456789abcdef01234567"])(
    "Z7/Z10: kod %s → 404 TICKET_NOT_FOUND",
    async (code) => {
      expectError(await apiGetTicket(code), 404, "TICKET_NOT_FOUND");
    },
  );
});

describe("Z12: awaria bazy → 500 INTERNAL_ERROR bez szczegółów", () => {
  const uri = process.env.MONGODB_URI;
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(async () => {
    await closeDb();
    process.env.MONGODB_URI = "zepsuty-uri://haslo@nie-ma-takiego-hosta";
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    process.env.MONGODB_URI = uri;
    consoleError.mockRestore();
    await closeDb();
  });

  it.each([
    ["POST /api/reservations", () => apiCreate(validBody())],
    ["POST /api/reservations/:id/purchase", () => apiPurchase("0123456789abcdef01234567")],
    ["GET /api/reservations/:id", () => apiGetReservation("0123456789abcdef01234567")],
    ["GET /api/tickets/:code", () => apiGetTicket("ABCD-EFGH")],
  ])("%s", async (context, call) => {
    const res = await call();
    expectError(res, 500, "INTERNAL_ERROR");
    expect(res.text).not.toContain("haslo");
    expect(res.text).not.toContain("zepsuty-uri");
    // Wyjątek jest w logach serwera, z nazwą endpointu.
    expect(consoleError).toHaveBeenCalledWith(`[${context}]`, expect.anything());
  });
});
