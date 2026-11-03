// Walidacja wejścia (Z6, Z7) — bez bazy.
import { describe, expect, it } from "vitest";
import {
  isReservationId,
  MAX_BODY_BYTES,
  normalizeTicketCode,
  readBodyBytes,
  readJsonBody,
  validateReservationBody,
} from "@/lib/validation";

const VALID = { eventId: "ic-1500-2026-12-04", seatId: "2-14", customerName: "Jan Kowalski", email: "jan@example.com" };

/** Poprawny składniowo e-mail o długości dokładnie n znaków (dla n ≈ 200–258; etykiety domeny ≤ 63). */
function emailOfLength(n: number): string {
  const local = "a".repeat(64);
  const middle = `${"b".repeat(63)}.${"c".repeat(63)}.`;
  const last = n - local.length - 1 - middle.length - ".pl".length;
  return `${local}@${middle}${"d".repeat(last)}.pl`;
}

describe("validateReservationBody", () => {
  it("poprawne body → trim i tylko 4 znane pola", () => {
    const result = validateReservationBody({
      eventId: "  ic-1500-2026-12-04 ",
      seatId: " 2-14",
      customerName: "  Jan Kowalski  ",
      email: " jan@example.com ",
      status: "paid",
      code: "AAAA-AAAA",
      active: false,
      _id: "x",
    });
    expect(result).toEqual({ ok: true, value: VALID });
  });

  it("e-mail wraca małymi literami, imię bez zmian (D6)", () => {
    const result = validateReservationBody({ ...VALID, customerName: "Jan KOWALSKI", email: " Jan.Kowalski@Example.COM " });
    expect(result).toEqual({ ok: true, value: { ...VALID, customerName: "Jan KOWALSKI", email: "jan.kowalski@example.com" } });
  });

  it("granice długości: 100 znaków imienia i 254 znaki e-maila przechodzą", () => {
    const email = emailOfLength(254);
    expect(email).toHaveLength(254);
    const result = validateReservationBody({ ...VALID, customerName: "x".repeat(100), email, eventId: "e".repeat(100), seatId: "s".repeat(100) });
    expect(result.ok).toBe(true);
  });

  it("polskie znaki i apostrof w imieniu są OK", () => {
    expect(validateReservationBody({ ...VALID, customerName: "Zażółć Gęśląjaźń-O'Brien" }).ok).toBe(true);
  });

  const invalid: [string, unknown][] = [
    ["null", null],
    ["tablica", [VALID]],
    ["liczba", 123],
    ["string", "eventId=1"],
    ["boolean", true],
    ["pusty obiekt", {}],
    ...(Object.keys(VALID) as (keyof typeof VALID)[]).flatMap((field): [string, unknown][] => [
      [`brak ${field}`, { ...VALID, [field]: undefined }],
      [`${field} = null`, { ...VALID, [field]: null }],
      [`${field} = liczba`, { ...VALID, [field]: 42 }],
      [`${field} = tablica`, { ...VALID, [field]: ["a"] }],
      [`${field} = obiekt {$ne: null}`, { ...VALID, [field]: { $ne: null } }],
      [`${field} = boolean`, { ...VALID, [field]: true }],
      [`${field} = ""`, { ...VALID, [field]: "" }],
      [`${field} = same spacje`, { ...VALID, [field]: "   \t\n " }],
    ]),
    ["customerName 101 znaków", { ...VALID, customerName: "x".repeat(101) }],
    ["customerName 10 000 znaków", { ...VALID, customerName: "x".repeat(10_000) }],
    ["customerName ze znakiem nowej linii", { ...VALID, customerName: "Jan\nKowalski" }],
    ["customerName z bajtem zerowym", { ...VALID, customerName: "Jan\u0000" }],
    ["eventId 101 znaków", { ...VALID, eventId: "e".repeat(101) }],
    ["seatId 101 znaków", { ...VALID, seatId: "1".repeat(101) }],
    ["email 255 znaków", { ...VALID, email: emailOfLength(255) }],
    ["email bez @", { ...VALID, email: "jan.example.com" }],
    ["email bez domeny", { ...VALID, email: "jan@" }],
    ["email bez części lokalnej", { ...VALID, email: "@example.com" }],
    ["email bez kropki w domenie", { ...VALID, email: "jan@localhost" }],
    ["email z kropką na końcu", { ...VALID, email: "jan@example." }],
    ["email ze spacją", { ...VALID, email: "jan kowalski@example.com" }],
    ["email z dwoma @", { ...VALID, email: "jan@@example.com" }],
    ["email z HTML", { ...VALID, email: "<script>@example.com" }],
    ["dziedziczone pole (prototype)", Object.create({ ...VALID })],
  ];

  it.each(invalid)("%s → błąd walidacji z komunikatem", (_name, body) => {
    const result = validateReservationBody(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toEqual(expect.any(String));
  });
});

describe("isReservationId", () => {
  it.each(["0123456789abcdef01234567", "a".repeat(24)])("%s → true", (id) => {
    expect(isReservationId(id)).toBe(true);
  });

  it.each([
    "abc",
    "{}",
    "%7B%7D",
    "a".repeat(12), // ObjectId.isValid przepuszcza 12 dowolnych znaków
    "a".repeat(23),
    "a".repeat(25),
    "A".repeat(24),
    "g".repeat(24),
    ` ${"a".repeat(24)}`,
    `${"a".repeat(24)}\n`,
    "a".repeat(10_000),
    "",
  ])("%s → false", (id) => {
    expect(isReservationId(id)).toBe(false);
  });

  it.each([null, undefined, 123, { $ne: null }, ["a".repeat(24)]])("nie-string %j → false", (id) => {
    expect(isReservationId(id)).toBe(false);
  });
});

describe("normalizeTicketCode", () => {
  it.each([
    ["ABCD-EFGH", "ABCD-EFGH"],
    ["abcd-efgh", "ABCD-EFGH"],
    ["  K7PQ-2M9X \n", "K7PQ-2M9X"],
  ])("%j → %s", (input, expected) => {
    expect(normalizeTicketCode(input)).toBe(expected);
  });

  it.each(["ABCDEFGH", "ABCD-EFG0", "ABCD-EFG1", "ABCD-EFGI", "ABCD-EFGO", "ABC-DEFGH", "ABCD-EFGH-", "ABCD_EFGH", "", "%7B%7D", "A".repeat(10_000)])(
    "%s → null",
    (input) => {
      expect(normalizeTicketCode(input)).toBeNull();
    },
  );

  it.each([null, 42, { $ne: null }, ["ABCD-EFGH"]])("nie-string %j → null", (input) => {
    expect(normalizeTicketCode(input)).toBeNull();
  });
});

describe("readJsonBody", () => {
  const post = (body: BodyInit | null, headers?: HeadersInit) =>
    new Request("http://localhost/api/reservations", { method: "POST", body, headers });

  /** Body jako strumień — bez nagłówka Content-Length, jak przy Transfer-Encoding: chunked. */
  function streamed(bytes: Uint8Array, chunkSize = 1024): Request {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
        controller.close();
      },
    });
    return new Request("http://localhost/api/reservations", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  }

  it("poprawny JSON", async () => {
    expect(await readJsonBody(post(JSON.stringify(VALID)))).toEqual({ ok: true, value: VALID });
  });

  it("JSON z BOM na początku", async () => {
    expect(await readJsonBody(post("﻿" + JSON.stringify(VALID)))).toEqual({ ok: true, value: VALID });
  });

  it.each([
    ["brak body", null],
    ["puste body", ""],
    ["nie-JSON", "nie-json"],
    ["ucięty JSON", '{"eventId": "x"'],
    ["form-urlencoded", "eventId=1&seatId=2"],
  ])("%s → błąd", async (_name, body) => {
    expect((await readJsonBody(post(body))).ok).toBe(false);
  });

  it("niepoprawne UTF-8 → błąd", async () => {
    const bytes = new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]); // {"\xff\xfe":1}
    expect((await readJsonBody(post(bytes))).ok).toBe(false);
  });

  it("dokładnie 10 kB przechodzi", async () => {
    const prefix = '{"pad":"';
    const suffix = '"}';
    const json = prefix + "x".repeat(MAX_BODY_BYTES - prefix.length - suffix.length) + suffix;
    expect(new TextEncoder().encode(json).length).toBe(MAX_BODY_BYTES);
    expect((await readJsonBody(post(json))).ok).toBe(true);
  });

  it("10 kB + 1 bajt → za duże", async () => {
    const json = JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) });
    const result = await readJsonBody(post(json));
    expect(result).toEqual({ ok: false, message: expect.stringContaining("za duża") });
  });

  it("1 MB bez Content-Length (strumień) → za duże, bez czytania całości", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ pad: "x".repeat(1024 * 1024) }));
    const result = await readJsonBody(streamed(bytes));
    expect(result).toEqual({ ok: false, message: expect.stringContaining("za duża") });
  });

  it("Content-Length większy niż limit → za duże od razu", async () => {
    const result = await readJsonBody(post("{}", { "content-length": String(MAX_BODY_BYTES + 1) }));
    expect(result.ok).toBe(false);
  });
});

describe("readBodyBytes", () => {
  it("zwraca dokładnie te bajty, które przyszły", async () => {
    const bytes = new Uint8Array([0x7b, 0xff, 0x00, 0x7d]);
    const req = new Request("http://localhost/x", { method: "POST", body: bytes });
    expect(await readBodyBytes(req, 10)).toEqual({ ok: true, value: bytes });
  });

  it("brak body → puste bajty", async () => {
    expect(await readBodyBytes(new Request("http://localhost/x", { method: "POST" }), 10)).toEqual({
      ok: true,
      value: new Uint8Array(),
    });
  });

  it("ponad limit → za duże", async () => {
    const req = new Request("http://localhost/x", { method: "POST", body: new Uint8Array(11) });
    expect((await readBodyBytes(req, 10)).ok).toBe(false);
  });
});
