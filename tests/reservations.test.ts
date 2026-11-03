// Logika rezerwacji na prawdziwej bazie pociag_test — poziom funkcji z src/lib.
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, ensureIndexes, getDb, RESERVATIONS_COLLECTION } from "@/lib/db";
import {
  createReservation,
  getReservation,
  getTakenSeats,
  getTicketByCode,
  purchaseReservation,
  releaseExpired,
} from "@/lib/reservations";
import { TICKET_CODE_REGEX, type CreateReservationBody } from "@/lib/types";
import {
  DEPARTED_EVENT,
  FUTURE_EVENT,
  reservationsCollection,
  resetTestData,
  setTtl,
  SHORT_TTL_SECONDS,
  validBody,
  waitForExpiry,
} from "./helpers";

const input = (overrides: Partial<CreateReservationBody> = {}) =>
  validBody(overrides) as unknown as CreateReservationBody;

async function reserve(seatId: string): Promise<string> {
  const result = await createReservation(input({ seatId }));
  if (!result.ok) throw new Error(`Rezerwacja ${seatId} nie powiodła się: ${result.error}`);
  return result.reservationId;
}

beforeAll(resetTestData);
beforeEach(async () => {
  setTtl(60);
  await (await reservationsCollection()).deleteMany({});
});
afterAll(async () => {
  setTtl(undefined);
  await closeDb();
});

describe("ensureIndexes", () => {
  it("tworzy unikalny częściowy indeks miejsca, unikalny indeks kodu i indeks kursu", async () => {
    const indexes = await (await getDb()).collection(RESERVATIONS_COLLECTION).indexes();
    const byName = Object.fromEntries(indexes.map((index) => [index.name, index]));

    expect(byName.uniq_active_seat).toMatchObject({
      key: { eventId: 1, seatId: 1 },
      unique: true,
      partialFilterExpression: { active: true },
    });
    expect(byName.uniq_code).toMatchObject({
      key: { code: 1 },
      unique: true,
      partialFilterExpression: { code: { $type: "string" } },
    });
    expect(byName.event_active).toMatchObject({ key: { eventId: 1, active: 1 } });
  });

  it("jest idempotentne i bezpieczne przy równoległych wywołaniach", async () => {
    const db = await getDb();
    await expect(Promise.all(Array.from({ length: 5 }, () => ensureIndexes(db)))).resolves.toBeDefined();
  });
});

describe("createReservation", () => {
  it("zapisuje rezerwację held z kodem null, TTL z env i bez dodatkowych pól", async () => {
    setTtl(120);
    const before = Date.now();
    const result = await createReservation({
      ...input({ seatId: "2-14" }),
      // Pola spoza kontraktu nie mogą trafić do bazy.
      ...({ status: "paid", code: "AAAA-AAAA", active: false } as object),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const doc = await (await reservationsCollection()).findOne({ _id: new ObjectId(result.reservationId) });
    expect(Object.keys(doc ?? {}).sort()).toEqual(
      ["_id", "active", "code", "createdAt", "customerName", "email", "eventId", "expiresAt", "seatId", "status"].sort(),
    );
    expect(doc).toMatchObject({ eventId: FUTURE_EVENT._id, seatId: "2-14", status: "held", active: true, code: null });
    expect(doc!.expiresAt.getTime() - doc!.createdAt.getTime()).toBe(120_000);
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 120_000);
  });

  it("Z1: 50 równoległych rezerwacji tego samego miejsca → dokładnie 1 sukces, reszta SEAT_TAKEN", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => createReservation(input({ seatId: "1-7" }))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === "SEAT_TAKEN")).toHaveLength(49);
    expect(await (await reservationsCollection()).countDocuments({ seatId: "1-7", active: true })).toBe(1);
  });

  it("równoległe rezerwacje różnych miejsc nie blokują się nawzajem", async () => {
    const seats = FUTURE_EVENT.seats.slice(0, 20);
    const results = await Promise.all(seats.map((seatId) => createReservation(input({ seatId }))));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await getTakenSeats(FUTURE_EVENT._id)).toEqual([...seats].sort());
  });

  it("Z8: nieistniejący kurs → EVENT_NOT_FOUND", async () => {
    expect(await createReservation(input({ eventId: "nie-ma-takiego" }))).toEqual({ ok: false, error: "EVENT_NOT_FOUND" });
  });

  it.each(["9-99", "1-21", "3-1", "0-1", "1-01", "abc"])("Z8: miejsce %s spoza kursu → INVALID_SEAT", async (seatId) => {
    expect(await createReservation(input({ seatId }))).toEqual({ ok: false, error: "INVALID_SEAT" });
  });

  it("Z9: kurs już odjechał → EVENT_DEPARTED", async () => {
    expect(await createReservation(input({ eventId: DEPARTED_EVENT._id }))).toEqual({
      ok: false,
      error: "EVENT_DEPARTED",
    });
  });
});

describe("wygasanie (Z2)", () => {
  it("po TTL miejsce znika z getTakenSeats i da się je zarezerwować ponownie", async () => {
    setTtl(SHORT_TTL_SECONDS);
    const firstId = await reserve("1-3");
    expect(await getTakenSeats(FUTURE_EVENT._id)).toContain("1-3");
    expect((await createReservation(input({ seatId: "1-3" }))).ok).toBe(false);

    await waitForExpiry();

    // Znika od razu — bez czekania na releaseExpired.
    expect(await getTakenSeats(FUTURE_EVENT._id)).not.toContain("1-3");
    const second = await createReservation(input({ seatId: "1-3" }));
    expect(second.ok).toBe(true);

    const first = await (await reservationsCollection()).findOne({ _id: new ObjectId(firstId) });
    expect(first).toMatchObject({ status: "expired", active: false });
  });

  it("50 równoległych rezerwacji miejsca z wygasłą rezerwacją → dokładnie 1 sukces", async () => {
    setTtl(SHORT_TTL_SECONDS);
    await reserve("1-4");
    await waitForExpiry();
    setTtl(60);
    const results = await Promise.all(Array.from({ length: 50 }, () => createReservation(input({ seatId: "1-4" }))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await (await reservationsCollection()).countDocuments({ seatId: "1-4", active: true })).toBe(1);
  });

  it("releaseExpired zwalnia tylko wygasłe held i tylko wskazane miejsce", async () => {
    setTtl(SHORT_TTL_SECONDS);
    await reserve("2-1");
    await reserve("2-2");
    setTtl(60);
    await reserve("2-3");
    await waitForExpiry();

    expect(await releaseExpired(FUTURE_EVENT._id, "2-1")).toBe(1);
    const reservations = await reservationsCollection();
    expect(await reservations.findOne({ seatId: "2-2" })).toMatchObject({ status: "held", active: true });
    expect(await releaseExpired(FUTURE_EVENT._id)).toBe(1); // 2-2
    expect(await reservations.findOne({ seatId: "2-3" })).toMatchObject({ status: "held", active: true });
  });
});

describe("purchaseReservation", () => {
  it("kupuje: zwraca kod w formacie XXXX-XXXX i zapisuje paid", async () => {
    const id = await reserve("1-1");
    const result = await purchaseReservation(id);
    expect(result).toEqual({ ok: true, code: expect.stringMatching(TICKET_CODE_REGEX) });

    const doc = await (await reservationsCollection()).findOne({ _id: new ObjectId(id) });
    expect(doc).toMatchObject({ status: "paid", active: true, code: result.ok ? result.code : "" });
    expect(doc!.paidAt).toBeInstanceOf(Date);
  });

  it("Z4: drugi zakup → ten sam kod", async () => {
    const id = await reserve("1-2");
    const first = await purchaseReservation(id);
    const second = await purchaseReservation(id);
    expect(first.ok && second.ok).toBe(true);
    expect(second).toEqual(first);
  });

  it("Z4: 10 równoległych zakupów → wszystkie OK z jednym kodem", async () => {
    const id = await reserve("1-5");
    const results = await Promise.all(Array.from({ length: 10 }, () => purchaseReservation(id)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => (r.ok ? r.code : null))).size).toBe(1);
  });

  it("Z3: zakup po TTL → RESERVATION_EXPIRED i rezerwacja oznaczona expired", async () => {
    setTtl(SHORT_TTL_SECONDS);
    const id = await reserve("1-6");
    await waitForExpiry();

    expect(await purchaseReservation(id)).toEqual({ ok: false, error: "RESERVATION_EXPIRED" });
    expect(await purchaseReservation(id)).toEqual({ ok: false, error: "RESERVATION_EXPIRED" });
    const doc = await (await reservationsCollection()).findOne({ _id: new ObjectId(id) });
    expect(doc).toMatchObject({ status: "expired", active: false, code: null });
  });

  it("Z3: 10 równoległych zakupów po TTL → same RESERVATION_EXPIRED", async () => {
    setTtl(SHORT_TTL_SECONDS);
    const id = await reserve("1-8");
    await waitForExpiry();
    const results = await Promise.all(Array.from({ length: 10 }, () => purchaseReservation(id)));
    expect(results.every((r) => !r.ok && r.error === "RESERVATION_EXPIRED")).toBe(true);
  });

  it("nieistniejąca lub zła rezerwacja → RESERVATION_NOT_FOUND", async () => {
    const notFound = { ok: false, error: "RESERVATION_NOT_FOUND" };
    expect(await purchaseReservation(new ObjectId().toHexString())).toEqual(notFound);
    expect(await purchaseReservation("abc")).toEqual(notFound);
    expect(await purchaseReservation("a".repeat(12))).toEqual(notFound);
  });
});

describe("Z21: rezerwacja nie trwa dłużej niż do odjazdu", () => {
  const SOON_EVENT_ID = "test-departs-soon";

  async function insertEventDepartingIn(ms: number) {
    const startsAt = new Date(Date.now() + ms).toISOString();
    const event = { ...FUTURE_EVENT, _id: SOON_EVENT_ID, startsAt };
    await (await getDb()).collection<typeof event>("events").replaceOne({ _id: SOON_EVENT_ID }, event, { upsert: true });
    return event;
  }

  afterAll(async () => {
    await (await getDb()).collection<{ _id: string }>("events").deleteOne({ _id: SOON_EVENT_ID });
  });

  it("kurs dalej niż TTL → expiresAt = createdAt + TTL (bez zmian)", async () => {
    const before = Date.now();
    const result = await createReservation(input({ seatId: "1-3" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(result.expiresAt.getTime()).toBeLessThan(new Date(FUTURE_EVENT.startsAt).getTime());
  });

  it("odjazd przed końcem TTL → expiresAt = startsAt; po odjeździe zakup → 410, miejsce wolne", async () => {
    setTtl(900);
    const event = await insertEventDepartingIn(SHORT_TTL_SECONDS * 1000);
    const result = await createReservation(input({ eventId: SOON_EVENT_ID, seatId: "1-4" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.expiresAt.toISOString()).toBe(event.startsAt);
    expect(await getTakenSeats(SOON_EVENT_ID)).toContain("1-4");

    await waitForExpiry();
    expect(await purchaseReservation(result.reservationId)).toEqual({ ok: false, error: "RESERVATION_EXPIRED" });
    expect((await getReservation(result.reservationId))?.status).toBe("expired");
    expect(await getTakenSeats(SOON_EVENT_ID)).not.toContain("1-4");
    // Po odjeździe nowej rezerwacji już się nie zrobi.
    expect(await createReservation(input({ eventId: SOON_EVENT_ID, seatId: "1-4" }))).toEqual({
      ok: false,
      error: "EVENT_DEPARTED",
    });
  });
});

describe("Z5: kupione miejsce nigdy nie wraca do puli", () => {
  it("po TTL i po releaseExpired dalej zajęte, a ponowna rezerwacja → SEAT_TAKEN", async () => {
    setTtl(SHORT_TTL_SECONDS);
    const id = await reserve("2-20");
    const purchase = await purchaseReservation(id);
    expect(purchase.ok).toBe(true);

    await waitForExpiry();
    expect(await releaseExpired(FUTURE_EVENT._id)).toBe(0);
    expect(await releaseExpired(FUTURE_EVENT._id, "2-20")).toBe(0);

    expect(await getTakenSeats(FUTURE_EVENT._id)).toContain("2-20");
    expect(await createReservation(input({ seatId: "2-20" }))).toEqual({ ok: false, error: "SEAT_TAKEN" });
    expect(await purchaseReservation(id)).toEqual(purchase);

    const doc = await (await reservationsCollection()).findOne({ _id: new ObjectId(id) });
    expect(doc).toMatchObject({ status: "paid", active: true });
    expect((await getReservation(id))?.status).toBe("paid");
  });
});

describe("getTakenSeats", () => {
  it("pusty kurs → []", async () => {
    expect(await getTakenSeats(FUTURE_EVENT._id)).toEqual([]);
  });

  it("nie-string (próba NoSQL injection) → []", async () => {
    await reserve("1-9");
    expect(await getTakenSeats({ $ne: null } as unknown as string)).toEqual([]);
  });

  it("nie miesza kursów", async () => {
    await reserve("1-10");
    expect(await getTakenSeats(DEPARTED_EVENT._id)).toEqual([]);
  });
});

describe("getReservation i getTicketByCode", () => {
  it("held: status held, bez kodu i bez e-maila", async () => {
    const id = await reserve("1-11");
    const reservation = await getReservation(id);
    expect(reservation).toMatchObject({ reservationId: id, eventId: FUTURE_EVENT._id, seatId: "1-11", status: "held" });
    expect(reservation).not.toHaveProperty("code");
    expect(reservation).not.toHaveProperty("email");
    expect(reservation?.event._id).toBe(FUTURE_EVENT._id);
  });

  it("held po TTL → status wyliczony expired (zanim cokolwiek ją oznaczy)", async () => {
    setTtl(SHORT_TTL_SECONDS);
    const id = await reserve("1-12");
    await waitForExpiry();
    expect((await getReservation(id))?.status).toBe("expired");
    // W bazie dalej held — status jest wyliczany przy odczycie.
    expect(await (await reservationsCollection()).findOne({ _id: new ObjectId(id) })).toMatchObject({ status: "held" });
  });

  it("paid: kod w rezerwacji i bilet po kodzie (także małymi literami)", async () => {
    const id = await reserve("1-13");
    const purchase = await purchaseReservation(id);
    if (!purchase.ok) throw new Error("zakup nie powiódł się");

    expect((await getReservation(id))?.code).toBe(purchase.code);
    const ticket = await getTicketByCode(` ${purchase.code.toLowerCase()} `);
    expect(ticket).toMatchObject({ code: purchase.code, seatId: "1-13" });
    expect(ticket).not.toHaveProperty("email");
  });

  it("bilet nie istnieje dla rezerwacji held ani dla złego kodu", async () => {
    await reserve("1-14");
    expect(await getTicketByCode("ABCD-EFGH")).toBeNull();
    expect(await getTicketByCode("nie-kod")).toBeNull();
  });

  it("zły lub nieistniejący id → null", async () => {
    expect(await getReservation("abc")).toBeNull();
    expect(await getReservation(new ObjectId().toHexString())).toBeNull();
  });
});
