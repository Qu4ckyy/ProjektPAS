// Logika rezerwacji na prawdziwej bazie pociag_test — poziom funkcji z src/lib.
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, ensureIndexes, getDb, RESERVATIONS_COLLECTION } from "@/lib/db";
import {
  createReservation,
  getCheckoutCandidate,
  getLegacyPurchase,
  getReservation,
  getTakenSeats,
  getTicketByCode,
  releaseExpired,
  saveCheckoutSession,
} from "@/lib/reservations";
import { TICKET_CODE_REGEX, type CreateReservationBody } from "@/lib/types";
import {
  DEPARTED_EVENT,
  FUTURE_EVENT,
  payReservation,
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
    expect(byName.payment_session).toMatchObject({ key: { "payment.sessionId": 1 } });
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
      ["_id", "active", "amount", "code", "createdAt", "customerName", "email", "eventId", "expiresAt", "seatId", "status"].sort(),
    );
    expect(doc).toMatchObject({ eventId: FUTURE_EVENT._id, seatId: "2-14", status: "held", active: true, code: null });
    // Cena zapisana w chwili rezerwacji (CONTRACT.md §2, Z29).
    expect(doc!.amount).toBe(FUTURE_EVENT.price);
    expect(result.amount).toBe(FUTURE_EVENT.price);
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

describe("D6, Z22: identyczna rezerwacja wysłana ponownie", () => {
  it("po kolei → ta sama rezerwacja; nie przedłuża czasu i nie tworzy drugiego dokumentu", async () => {
    const body = input({ seatId: "1-1" });
    const first = await createReservation(body);
    const second = await createReservation(body);
    expect(first).toMatchObject({ ok: true, replay: false });
    expect(second).toMatchObject({ ok: true, replay: true });
    if (!first.ok || !second.ok) return;
    expect(second.reservationId).toBe(first.reservationId);
    expect(second.expiresAt).toEqual(first.expiresAt);
    expect(second.amount).toBe(first.amount);
    expect(await (await reservationsCollection()).countDocuments({ seatId: "1-1" })).toBe(1);
  });

  it("20 równoległych identycznych → jedna rezerwacja, jeden nowy, reszta to powtórki", async () => {
    const body = input({ seatId: "1-2" });
    const results = await Promise.all(Array.from({ length: 20 }, () => createReservation(body)));
    const ids = new Set(results.map((r) => (r.ok ? r.reservationId : null)));
    expect(ids.size).toBe(1);
    expect(ids.has(null)).toBe(false);
    expect(results.filter((r) => r.ok && !r.replay)).toHaveLength(1);
    expect(await (await reservationsCollection()).countDocuments({ seatId: "1-2" })).toBe(1);
  });

  it("inna osoba: to samo imię z innym e-mailem albo inne imię z tym samym e-mailem → SEAT_TAKEN", async () => {
    const body = input({ seatId: "1-3" });
    await createReservation(body);
    const taken = { ok: false, error: "SEAT_TAKEN" };
    expect(await createReservation({ ...body, email: "ktos.inny@example.com" })).toEqual(taken);
    expect(await createReservation({ ...body, customerName: "Ktoś Inny" })).toEqual(taken);
  });

  it("opłacona rezerwacja tej samej osoby → ta sama rezerwacja, kod bez zmian", async () => {
    const body = input({ seatId: "1-4" });
    const first = await createReservation(body);
    if (!first.ok) throw new Error("rezerwacja nie powiodła się");
    const code = await payReservation(first.reservationId);

    expect(await createReservation(body)).toMatchObject({ ok: true, replay: true, reservationId: first.reservationId });
    expect((await getReservation(first.reservationId))?.code).toBe(code);
  });

  it("po wygaśnięciu ta sama osoba dostaje nową rezerwację", async () => {
    setTtl(SHORT_TTL_SECONDS);
    const body = input({ seatId: "1-5" });
    const first = await createReservation(body);
    await waitForExpiry();
    setTtl(60);
    const second = await createReservation(body);
    expect(second).toMatchObject({ ok: true, replay: false });
    if (first.ok && second.ok) expect(second.reservationId).not.toBe(first.reservationId);
  });
});

describe("D5: getLegacyPurchase — biletu bez płatności nie ma", () => {
  it("held → PAYMENT_REQUIRED i nic się nie zmienia", async () => {
    const id = await reserve("1-1");
    expect(await getLegacyPurchase(id)).toEqual({ ok: false, error: "PAYMENT_REQUIRED" });
    expect(await (await reservationsCollection()).findOne({ _id: new ObjectId(id) })).toMatchObject({
      status: "held",
      code: null,
    });
  });

  it("paid → ten sam kod za każdym razem", async () => {
    const id = await reserve("1-2");
    const code = await payReservation(id);
    expect(code).toMatch(TICKET_CODE_REGEX);
    expect(await getLegacyPurchase(id)).toEqual({ ok: true, code });
    expect(await getLegacyPurchase(id)).toEqual({ ok: true, code });
  });

  it("po TTL → RESERVATION_EXPIRED", async () => {
    setTtl(SHORT_TTL_SECONDS);
    const id = await reserve("1-6");
    await waitForExpiry();
    expect(await getLegacyPurchase(id)).toEqual({ ok: false, error: "RESERVATION_EXPIRED" });
  });

  it("nieistniejąca lub zła rezerwacja → RESERVATION_NOT_FOUND", async () => {
    const notFound = { ok: false, error: "RESERVATION_NOT_FOUND" };
    expect(await getLegacyPurchase(new ObjectId().toHexString())).toEqual(notFound);
    expect(await getLegacyPurchase("abc")).toEqual(notFound);
    expect(await getLegacyPurchase("a".repeat(12))).toEqual(notFound);
  });
});

describe("getCheckoutCandidate i saveCheckoutSession (§6)", () => {
  const session = { sessionId: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", pointsUsed: 0, cardAmount: 8900 };

  it("held: pełny dokument z e-mailem i kurs", async () => {
    const body = input({ seatId: "1-1" });
    const created = await createReservation(body);
    if (!created.ok) throw new Error("rezerwacja nie powiodła się");

    const candidate = await getCheckoutCandidate(created.reservationId);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    expect(candidate.reservation.email).toBe(body.email);
    expect(candidate.reservation.amount).toBe(FUTURE_EVENT.price);
    expect(candidate.event._id).toBe(FUTURE_EVENT._id);
  });

  it("paid → ALREADY_PAID, po TTL → RESERVATION_EXPIRED, zły id → RESERVATION_NOT_FOUND", async () => {
    const paid = await reserve("1-2");
    await payReservation(paid);
    expect(await getCheckoutCandidate(paid)).toEqual({ ok: false, error: "ALREADY_PAID" });

    setTtl(SHORT_TTL_SECONDS);
    const expired = await reserve("1-3");
    await waitForExpiry();
    expect(await getCheckoutCandidate(expired)).toEqual({ ok: false, error: "RESERVATION_EXPIRED" });

    expect(await getCheckoutCandidate("abc")).toEqual({ ok: false, error: "RESERVATION_NOT_FOUND" });
  });

  it("zapisuje tylko pierwszą sesję, także przy równoległych zapisach", async () => {
    const id = await reserve("1-4");
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        saveCheckoutSession(id, i === 0 ? session : { sessionId: `cs_test_inna_${i}`, url: "https://example.com", pointsUsed: 0, cardAmount: 8900 }),
      ),
    );
    const doc = await (await reservationsCollection()).findOne({ _id: new ObjectId(id) });
    expect(doc?.payment?.sessionId).toMatch(/^cs_test_/);
    expect(doc?.payment?.createdAt).toBeInstanceOf(Date);
    const saved = doc!.payment!;

    await saveCheckoutSession(id, { sessionId: "cs_test_pozniej", url: "https://example.com/pozniej", pointsUsed: 0, cardAmount: 8900 });
    const again = await (await reservationsCollection()).findOne({ _id: new ObjectId(id) });
    expect(again?.payment).toEqual(saved);
  });

  it("nie zapisuje sesji na opłaconej rezerwacji", async () => {
    const id = await reserve("1-5");
    await payReservation(id);
    await saveCheckoutSession(id, session);
    const doc = await (await reservationsCollection()).findOne({ _id: new ObjectId(id) });
    expect(doc?.payment?.sessionId).not.toBe(session.sessionId);
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

  it("odjazd przed końcem TTL → expiresAt = startsAt; po odjeździe rezerwacja wygasła, miejsce wolne", async () => {
    setTtl(900);
    const event = await insertEventDepartingIn(SHORT_TTL_SECONDS * 1000);
    const result = await createReservation(input({ eventId: SOON_EVENT_ID, seatId: "1-4" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.expiresAt.toISOString()).toBe(event.startsAt);
    expect(await getTakenSeats(SOON_EVENT_ID)).toContain("1-4");

    await waitForExpiry();
    expect(await getLegacyPurchase(result.reservationId)).toEqual({ ok: false, error: "RESERVATION_EXPIRED" });
    expect((await getReservation(result.reservationId))?.status).toBe("expired");
    expect(await getTakenSeats(SOON_EVENT_ID)).not.toContain("1-4");
    // Po odjeździe nowej rezerwacji już się nie zrobi.
    expect(await createReservation(input({ eventId: SOON_EVENT_ID, seatId: "1-4" }))).toEqual({
      ok: false,
      error: "EVENT_DEPARTED",
    });
  });
});

describe("Z5: opłacone miejsce nigdy nie wraca do puli", () => {
  it("po TTL i po releaseExpired dalej zajęte, a ponowna rezerwacja → SEAT_TAKEN", async () => {
    setTtl(SHORT_TTL_SECONDS);
    const id = await reserve("2-20");
    const code = await payReservation(id);

    await waitForExpiry();
    expect(await releaseExpired(FUTURE_EVENT._id)).toBe(0);
    expect(await releaseExpired(FUTURE_EVENT._id, "2-20")).toBe(0);

    expect(await getTakenSeats(FUTURE_EVENT._id)).toContain("2-20");
    expect(await createReservation(input({ seatId: "2-20" }))).toEqual({ ok: false, error: "SEAT_TAKEN" });
    expect(await getLegacyPurchase(id)).toEqual({ ok: true, code });

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
    const code = await payReservation(id);

    expect((await getReservation(id))?.code).toBe(code);
    const ticket = await getTicketByCode(` ${code.toLowerCase()} `);
    expect(ticket).toMatchObject({ code, seatId: "1-13", amount: FUTURE_EVENT.price });
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
