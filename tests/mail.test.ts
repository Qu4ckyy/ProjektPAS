// Mail z biletem (karta C) — CONTRACT.md §3 „Mail z biletem”, D19, Z46–Z48. Właściciel: Mateusz.
// Resend zmockowany przez fetch — żaden test nie wysyła prawdziwego maila.
import { ObjectId } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTicketEmail, MAX_EMAIL_ATTEMPTS, retryTicketEmails, sendTicketEmail } from "@/lib/mail";
import { generateCode } from "@/lib/payments";
import type { Reservation } from "@/lib/types";
import { FUTURE_EVENT, reservationsCollection, resetTestData } from "./helpers";

let seq = 0;

/** Opłacona rezerwacja wstawiona wprost — mail dotyczy tylko paid. */
async function insertReservation(overrides: Partial<Reservation> = {}): Promise<string> {
  seq++;
  const _id = new ObjectId();
  await (await reservationsCollection()).insertOne({
    _id,
    eventId: FUTURE_EVENT._id,
    seatId: `2-${seq}`,
    customerName: "Anna Nowak",
    email: `delivered+anna${seq}@resend.dev`,
    amount: 8900,
    code: generateCode(),
    status: "paid",
    active: true,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    paidAt: new Date(),
    pointsUsed: 1000,
    cardAmount: 7900,
    pointsEarned: 790,
    ...overrides,
  });
  return _id.toHexString();
}

async function ticketEmailOf(id: string) {
  const doc = await (await reservationsCollection()).findOne({ _id: new ObjectId(id) });
  return doc?.ticketEmail;
}

function resendResponse(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(async () => {
  await resetTestData();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("MAIL_PROVIDER", "resend");
  vi.stubEnv("RESEND_API_KEY", "re_test_dummy");
  vi.stubEnv("MAIL_FROM", "Konduktor <onboarding@resend.dev>");
  vi.stubEnv("APP_URL", "https://konduktor.example");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sendTicketEmail — Resend", () => {
  it("wysyła raz z Idempotency-Key ticket-<id> i zapisuje sent + resendId", async () => {
    fetchMock.mockImplementation(async () => resendResponse(200, { id: "re_msg_1" }));
    const id = await insertReservation();

    await sendTicketEmail(id);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(`ticket-${id}`);
    expect(headers.Authorization).toBe("Bearer re_test_dummy");
    const body = JSON.parse(String(init?.body));
    expect(body.to).toEqual([expect.stringMatching(/^delivered\+anna\d+@resend\.dev$/)]);
    expect(body.from).toBe("Konduktor <onboarding@resend.dev>");
    expect(body.subject).toMatch(/^Bilet [A-Z2-9]{4}-[A-Z2-9]{4} — /);
    expect(body.text).toContain("Zapłacono kartą: 79,00");
    expect(body.text).toContain("Zapłacono punktami: 1000 pkt");
    expect(body.text).toContain("Zebrane punkty: 790 pkt");
    expect(body.text).toMatch(/https:\/\/konduktor\.example\/reservations\/[A-Z2-9]{4}-[A-Z2-9]{4}/);

    expect(await ticketEmailOf(id)).toMatchObject({ status: "sent", resendId: "re_msg_1", attempts: 1 });
  });

  it("drugi raz (powtórka webhooka, GET po webhooku) nic nie wysyła (Z46)", async () => {
    fetchMock.mockImplementation(async () => resendResponse(200, { id: "re_msg_2" }));
    const id = await insertReservation();

    await sendTicketEmail(id);
    await sendTicketEmail(id);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5 równoległych wywołań → jedno wywołanie Resend (Z46)", async () => {
    fetchMock.mockImplementation(async () => resendResponse(200, { id: "re_msg_3" }));
    const id = await insertReservation();

    await Promise.all(Array.from({ length: 5 }, () => sendTicketEmail(id)));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await ticketEmailOf(id))?.status).toBe("sent");
  });

  it("409 invalid_idempotent_request = mail już wyszedł → sent bez kolejnych prób", async () => {
    fetchMock.mockImplementation(async () => resendResponse(409, { name: "invalid_idempotent_request" }));
    const id = await insertReservation();

    await sendTicketEmail(id);

    expect((await ticketEmailOf(id))?.status).toBe("sent");
  });

  it("429 → retry, po 5 próbach failed i koniec wysyłania", async () => {
    fetchMock.mockImplementation(async () => resendResponse(429, { name: "rate_limit_exceeded" }));
    const id = await insertReservation();

    for (let i = 1; i < MAX_EMAIL_ATTEMPTS; i++) {
      await sendTicketEmail(id);
      expect(await ticketEmailOf(id)).toMatchObject({ status: "retry", attempts: i, lastError: "HTTP 429 rate_limit_exceeded" });
    }
    await sendTicketEmail(id);
    expect(await ticketEmailOf(id)).toMatchObject({ status: "failed", attempts: MAX_EMAIL_ATTEMPTS });

    await sendTicketEmail(id);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_EMAIL_ATTEMPTS);
  });

  it("błąd sieci i 5xx → retry", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const id = await insertReservation();
    await sendTicketEmail(id);
    expect((await ticketEmailOf(id))?.status).toBe("retry");

    fetchMock.mockResolvedValueOnce(resendResponse(503));
    await sendTicketEmail(id);
    expect(await ticketEmailOf(id)).toMatchObject({ status: "retry", attempts: 2 });
  });

  it("403 (adres spoza testowych) → failed bez ponowień; bilet nietknięty (Z47)", async () => {
    fetchMock.mockImplementation(async () => resendResponse(403, { name: "validation_error" }));
    const id = await insertReservation();

    await sendTicketEmail(id);
    await sendTicketEmail(id);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const doc = await (await reservationsCollection()).findOne({ _id: new ObjectId(id) });
    expect(doc?.ticketEmail).toMatchObject({ status: "failed", lastError: "HTTP 403 validation_error" });
    expect(doc?.status).toBe("paid");
    expect(doc?.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("brak RESEND_API_KEY → failed bez wywołania i bez wyjątku", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const id = await insertReservation();

    await expect(sendTicketEmail(id)).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await ticketEmailOf(id)).toMatchObject({ status: "failed", lastError: "Brak RESEND_API_KEY" });
  });

  it("nieopłacona rezerwacja i zły id → nic nie wysyła", async () => {
    const held = await insertReservation({ status: "held", code: null });

    await sendTicketEmail(held);
    await sendTicketEmail("abc");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await ticketEmailOf(held)).toBeUndefined();
  });

  it("retryTicketEmails wysyła zaległe retry, a pomija sent i failed", async () => {
    fetchMock.mockImplementation(async () => resendResponse(200, { id: "re_msg_retry" }));
    const now = new Date();
    const retry = await insertReservation({ ticketEmail: { status: "retry", attempts: 1, at: now } });
    await insertReservation({ ticketEmail: { status: "sent", attempts: 1, at: now, resendId: "x" } });
    await insertReservation({ ticketEmail: { status: "failed", attempts: 1, at: now } });

    expect(await retryTicketEmails()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await ticketEmailOf(retry))?.status).toBe("sent");
  });
});

describe("buildTicketEmail — treść (Z48)", () => {
  const base = {
    code: "ABCD-EFGH",
    customerName: "Anna Nowak",
    seatId: "1-5",
    amount: 8900,
    pointsUsed: 1000,
    cardAmount: 7900,
    pointsEarned: 790,
  };

  it("imię z HTML-em trafia do maila jako tekst", () => {
    const { html, text } = buildTicketEmail(
      { ...base, customerName: `<img src=x onerror=alert(1)><a href="https://zlo.example">kliknij</a>` },
      FUTURE_EVENT,
      "https://konduktor.example",
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('href="https://zlo.example"');
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(text).toContain("<img src=x onerror=alert(1)>");
  });

  it("bez punktów nie ma linii o punktach, a zebrane liczą się od pełnej ceny", () => {
    const { html, text } = buildTicketEmail(
      { ...base, pointsUsed: 0, cardAmount: 8900, pointsEarned: 890 },
      FUTURE_EVENT,
      "https://konduktor.example",
    );
    expect(text).not.toContain("Zapłacono punktami");
    expect(html).not.toContain("Zapłacono punktami");
    expect(text).toContain("Zapłacono kartą: 89,00");
    expect(text).toContain("Zebrane punkty: 890 pkt");
  });

  it("temat z kodem i pociągiem; bez APP_URL brak linku", () => {
    const { subject, html, text } = buildTicketEmail(base, FUTURE_EVENT, null);
    expect(subject).toBe(`Bilet ABCD-EFGH — ${FUTURE_EVENT.trainNumber} ${FUTURE_EVENT.from} → ${FUTURE_EVENT.to}`);
    expect(html).not.toContain("Otwórz bilet");
    expect(text).not.toContain("Bilet online");
    expect(text).toContain("Wagon 1, miejsce 5");
  });
});
