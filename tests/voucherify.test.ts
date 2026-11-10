// Klient Voucherify Loyalty Hub v2 (karta A) — CONTRACT.md §1, §3 „Operacje na punktach”, „Budżet wywołań”, D21.
// fetch zmockowany atrapą (tests/fake-voucherify.ts) — żadnego prawdziwego Voucherify.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { closeDb, getDb, LOYALTY_MEMBERS_COLLECTION } from "@/lib/db";
import {
  getLoyaltyClient,
  loyaltyProvider,
  LoyaltyUnavailableError,
  RATE_LIMIT_DOC_ID,
  resetVoucherifyRateLimit,
} from "@/lib/voucherify";
import { FAKE_CARD_DEFINITION_ID, FAKE_ENV, FakeVoucherify } from "./fake-voucherify";
import { resetTestData } from "./helpers";

const EMAIL = "delivered+jan@resend.dev";

let fake: FakeVoucherify;
let consoleError: MockInstance<typeof console.error>;

async function rateLimitDoc() {
  return (await getDb()).collection<{ _id: string; blockedUntil: Date }>(LOYALTY_MEMBERS_COLLECTION).findOne({ _id: RATE_LIMIT_DOC_ID });
}

/** Wyjątek z obietnicy — do sprawdzania pól LoyaltyUnavailableError. */
async function errorOf(promise: Promise<unknown>): Promise<LoyaltyUnavailableError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(LoyaltyUnavailableError);
    return err as LoyaltyUnavailableError;
  }
  throw new Error("oczekiwano LoyaltyUnavailableError");
}

beforeEach(async () => {
  await resetTestData();
  fake = new FakeVoucherify();
  vi.stubGlobal("fetch", fake.fetch);
  for (const [name, value] of Object.entries(FAKE_ENV)) vi.stubEnv(name, value);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  // Z50: sekret nigdy w logach.
  expect(JSON.stringify(consoleError.mock.calls)).not.toContain(FAKE_ENV.VOUCHERIFY_SECRET_KEY);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(closeDb);

describe("D21: wybór providera", () => {
  it("lokalnie domyślnie memory, voucherify tylko na żądanie", () => {
    vi.stubEnv("LOYALTY_PROVIDER", "");
    expect(loyaltyProvider()).toBe("memory");
    vi.stubEnv("LOYALTY_PROVIDER", " Voucherify ");
    expect(loyaltyProvider()).toBe("voucherify");
  });

  it("na produkcji Vercela memory jest odrzucane", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("LOYALTY_PROVIDER", "memory");
    expect(loyaltyProvider()).toBe("voucherify");
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("niedozwolone na produkcji"));
  });
});

describe("findMember", () => {
  it("e-mail z „+” kodowany w ścieżce, identification_type, nagłówki; brak członka → null", async () => {
    expect(await getLoyaltyClient().findMember(EMAIL)).toBeNull();

    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call.method).toBe("GET");
    expect(call.url).toContain("/memberships/delivered%2Bjan%40resend.dev?identification_type=customer_source_id");
    expect(call.url).toContain(`/v2/loyalties/programs/${FAKE_ENV.VOUCHERIFY_PROGRAM_ID}/`);
    expect(call.headers.get("x-app-id")).toBe(FAKE_ENV.VOUCHERIFY_APP_ID);
    expect(call.headers.get("x-app-token")).toBe(FAKE_ENV.VOUCHERIFY_SECRET_KEY);
    expect(call.headers.get("content-type")).toBeNull();
  });

  it("saldo z karty naszego portfela, nie z innej karty członka", async () => {
    const member = fake.addMemberFromPanel(EMAIL, 420);
    expect(await getLoyaltyClient().findMember(EMAIL)).toEqual({ memberId: member.memberId, cardId: member.cardId, balance: 420 });
  });

  it("adres API bez „/” na końcu", async () => {
    vi.stubEnv("VOUCHERIFY_API_URL", `${FAKE_ENV.VOUCHERIFY_API_URL}///`);
    await getLoyaltyClient().findMember(EMAIL);
    expect(fake.calls[0].url.startsWith(`${FAKE_ENV.VOUCHERIFY_API_URL}/v2/`)).toBe(true);
  });
});

describe("createMember", () => {
  it("upsert klienta, potem członek po customer_source_id → karta naszego portfela, created: true", async () => {
    const created = await getLoyaltyClient().createMember(EMAIL);
    const member = fake.members.get(EMAIL)!;
    expect(created).toEqual({ memberId: member.memberId, cardId: member.cardId, created: true });

    expect(fake.calls.map((c) => c.op)).toEqual(["createCustomer", "createMember"]);
    expect(fake.calls[0].body).toEqual({ source_id: EMAIL, email: EMAIL });
    expect(fake.calls[1].body).toEqual({ customer_identification: { type: "customer_source_id", customer_source_id: EMAIL } });
    expect(fake.calls[1].headers.get("content-type")).toBe("application/json");
  });

  it("drugi raz → 409 member_already_exists → istniejący członek, created: false", async () => {
    const first = await getLoyaltyClient().createMember(EMAIL);
    const second = await getLoyaltyClient().createMember(EMAIL);
    expect(second).toEqual({ ...first, created: false });
    expect(fake.count("findMember")).toBe(1);
  });

  it("karta tworzona asynchronicznie → jeden findMember po chwili", async () => {
    fake.cardAsync = true;
    const created = await getLoyaltyClient().createMember(EMAIL);
    expect(created.cardId).toBe(fake.members.get(EMAIL)!.cardId);
    expect(fake.count("findMember")).toBe(1);
  });
});

describe("punkty i transakcje", () => {
  it("addPoints → lctx_…; getTransaction: PENDING, potem APPROVED", async () => {
    const { memberId, cardId } = await getLoyaltyClient().createMember(EMAIL);
    fake.pendingReads = 1;
    const { transactionId } = await getLoyaltyClient().addPoints(memberId, cardId, 1000, "welcome-x");
    expect(transactionId).toMatch(/^lctx_/);
    expect(fake.calls.at(-1)?.body).toEqual({ points: 1000, reason: "welcome-x" });

    expect(await getLoyaltyClient().getTransaction(memberId, cardId, transactionId)).toEqual({ status: "PENDING" });
    expect(await getLoyaltyClient().getTransaction(memberId, cardId, transactionId)).toEqual({ status: "APPROVED" });
    expect(fake.calls.at(-1)?.url).toContain(`filters[id][conditions][$is]=${transactionId}`);
  });

  it("findTransactionByReason: najnowsza z tym reason, z punktami; filtr created_at; brak → null", async () => {
    const { memberId, cardId } = await getLoyaltyClient().createMember(EMAIL);
    const client = getLoyaltyClient();
    await client.addPoints(memberId, cardId, 1000, "welcome-x");
    const { transactionId } = await client.addPoints(memberId, cardId, -300, "spend-abc");
    const since = new Date(Date.now() - 60_000);

    expect(await client.findTransactionByReason(memberId, cardId, "spend-abc", since)).toEqual({
      transactionId,
      status: "APPROVED",
      points: -300,
    });
    expect(fake.calls.at(-1)?.url).toContain(`filters[created_at][conditions][$after]=${encodeURIComponent(since.toISOString())}`);
    expect(await client.findTransactionByReason(memberId, cardId, "earn-abc", since)).toBeNull();
  });

  it("pobranie ponad saldo → transakcja REJECTED (portfel bez ujemnego salda)", async () => {
    const { memberId, cardId } = await getLoyaltyClient().createMember(EMAIL);
    const { transactionId } = await getLoyaltyClient().addPoints(memberId, cardId, -1, "spend-abc");
    expect(await getLoyaltyClient().getTransaction(memberId, cardId, transactionId)).toEqual({ status: "REJECTED" });
  });
});

describe("D20: 429 i blokada wywołań", () => {
  it("429 z Retry-After → LoyaltyUnavailableError; do końca blokady zero wywołań, także w innym procesie", async () => {
    fake.fail("findMember", "429", { retryAfter: "120" });
    const err = await errorOf(getLoyaltyClient().findMember(EMAIL));
    expect(err.retryAfterSeconds).toBe(120);
    expect(err.uncertain).toBe(false);

    const doc = await rateLimitDoc();
    expect(doc!.blockedUntil.getTime()).toBeGreaterThan(Date.now() + 110_000);

    await errorOf(getLoyaltyClient().findMember(EMAIL));
    // Nowy proces (inna instancja Vercela): pamięć pusta, blokada z bazy.
    resetVoucherifyRateLimit();
    const again = await errorOf(getLoyaltyClient().createMember(EMAIL));
    expect(again.retryAfterSeconds).toBeGreaterThan(100);
    expect(fake.calls).toHaveLength(1);
  });

  it("X-Rate-Limit-Retry i brak nagłówka (domyślnie 60 s)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 429, headers: { "X-Rate-Limit-Retry": "30" } })),
    );
    expect((await errorOf(getLoyaltyClient().findMember(EMAIL))).retryAfterSeconds).toBe(30);

    await resetTestData();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429 })));
    expect((await errorOf(getLoyaltyClient().findMember(EMAIL))).retryAfterSeconds).toBe(60);
  });

  it("po końcu blokady Voucherify znów jest wołany", async () => {
    await (await getDb())
      .collection<{ _id: string; blockedUntil: Date }>(LOYALTY_MEMBERS_COLLECTION)
      .insertOne({ _id: RATE_LIMIT_DOC_ID, blockedUntil: new Date(Date.now() - 1_000) });
    expect(await getLoyaltyClient().findMember(EMAIL)).toBeNull();
    expect(fake.calls).toHaveLength(1);
  });
});

describe("Z43, Z44: niedostępność i niepewność", () => {
  it("423 (program nieaktywny) → niedostępne, nie niepewne, błąd w logach", async () => {
    fake.fail("findMember", "423");
    expect((await errorOf(getLoyaltyClient().findMember(EMAIL))).uncertain).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("423 non_active_program"));
  });

  it("odczyt: 500 i timeout → nie niepewne (nic nie zmienia salda)", async () => {
    fake.fail("findMember", "500").fail("findMember", "timeout-before");
    expect((await errorOf(getLoyaltyClient().findMember(EMAIL))).uncertain).toBe(false);
    expect((await errorOf(getLoyaltyClient().findMember(EMAIL))).uncertain).toBe(false);
  });

  it("zmiana salda: timeout, zerwane połączenie i 5xx → uncertain: true", async () => {
    const { memberId, cardId } = await getLoyaltyClient().createMember(EMAIL);
    fake.fail("addPoints", "timeout-after").fail("addPoints", "500");
    expect((await errorOf(getLoyaltyClient().addPoints(memberId, cardId, 10, "earn-a"))).uncertain).toBe(true);
    expect((await errorOf(getLoyaltyClient().addPoints(memberId, cardId, 10, "earn-b"))).uncertain).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    expect((await errorOf(getLoyaltyClient().addPoints(memberId, cardId, 10, "earn-c"))).uncertain).toBe(true);
  });

  it("brak konfiguracji → niedostępne bez wołania; w logu nazwa zmiennej, nie wartość", async () => {
    vi.stubEnv("VOUCHERIFY_SECRET_KEY", "");
    vi.stubEnv("VOUCHERIFY_CARD_DEFINITION_ID", "");
    await errorOf(getLoyaltyClient().findMember(EMAIL));
    expect(fake.calls).toHaveLength(0);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("VOUCHERIFY_SECRET_KEY, VOUCHERIFY_CARD_DEFINITION_ID"));
  });

  it("członkostwo bez karty naszego portfela → niedostępne (saldo nieznane), nie 1000", async () => {
    vi.stubEnv("VOUCHERIFY_CARD_DEFINITION_ID", "lcdef_inny_portfel");
    fake.addMemberFromPanel(EMAIL, 5);
    await errorOf(getLoyaltyClient().findMember(EMAIL));
    expect(FAKE_CARD_DEFINITION_ID).not.toBe("lcdef_inny_portfel");
  });

  it("logi nie zawierają e-maila klienta (ścieżka ma e-mail — logujemy nazwę operacji)", async () => {
    fake.fail("findMember", "500");
    await errorOf(getLoyaltyClient().findMember(EMAIL));
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("resend.dev");
  });
});
