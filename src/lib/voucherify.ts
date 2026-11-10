// Klient Voucherify Loyalty Hub v2 — CONTRACT.md §1, §3 „Operacje na punktach”, §6, D12, D20, D21. Właściciel: Eryk.
// Provider "voucherify": REST v2 + /v1/customers przez fetch (bez SDK). Provider "memory" do testów i lokalnej
// pracy: zachowuje się jak nasz portfel (od razu APPROVED, bez ujemnego salda).
import { getDb, LOYALTY_MEMBERS_COLLECTION } from "@/lib/db";

export type TransactionStatus = "PENDING" | "PROCESSING" | "APPROVED" | "REJECTED";

export type MemberRef = { memberId: string; cardId: string };

/** Transakcja znaleziona po reason; points ze znakiem (ujemne = pobranie). */
export type FoundTransaction = { transactionId: string; status: TransactionStatus; points: number };

export interface LoyaltyClient {
  /** Członkostwo e-maila w programie z saldem karty naszego portfela; brak → null. */
  findMember(email: string): Promise<(MemberRef & { balance: number }) | null>;
  /** Upsert klienta + członek programu; już był (409) → istniejący z created: false. */
  createMember(email: string): Promise<MemberRef & { created: boolean }>;
  /** Zmiana punktów (ujemne = pobranie) → transakcja, zwykle jeszcze PENDING (v2 jest asynchroniczne). */
  addPoints(memberId: string, cardId: string, points: number, reason: string): Promise<{ transactionId: string }>;
  getTransaction(memberId: string, cardId: string, transactionId: string): Promise<{ status: TransactionStatus }>;
  /** Nasza operacja po unikalnym reason (spend-<id>, earn-<id>, …) z transakcji od `since`; najnowsza. */
  findTransactionByReason(memberId: string, cardId: string, reason: string, since: Date): Promise<FoundTransaction | null>;
}

/**
 * Voucherify nie odpowiada, odmówił (429, 423, 5xx) albo nie jest skonfigurowany.
 * uncertain: żądanie zmieniające saldo mogło dojść (timeout, zerwane połączenie) — sprawdź po reason.
 */
export class LoyaltyUnavailableError extends Error {
  readonly retryAfterSeconds?: number;
  readonly uncertain: boolean;

  constructor(message: string, options: { retryAfterSeconds?: number; uncertain?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "LoyaltyUnavailableError";
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.uncertain = options.uncertain ?? false;
  }
}

export type LoyaltyProvider = "voucherify" | "memory";

/** memory tylko poza produkcją Vercela (D21); domyślnie memory lokalnie, voucherify na produkcji. */
export function loyaltyProvider(): LoyaltyProvider {
  const raw = process.env.LOYALTY_PROVIDER?.trim().toLowerCase();
  if (process.env.VERCEL_ENV === "production") {
    if (raw && raw !== "voucherify") {
      console.error(`[loyalty] LOYALTY_PROVIDER=${raw} jest niedozwolone na produkcji — używam voucherify.`);
    }
    return "voucherify";
  }
  return raw === "voucherify" ? "voucherify" : "memory";
}

export function getLoyaltyClient(): LoyaltyClient {
  return loyaltyProvider() === "memory" ? memoryClient : voucherifyClient;
}

// --- provider "voucherify" ---

/** Każde wywołanie z limitem czasu (CONTRACT.md §1). */
const REQUEST_TIMEOUT_MS = 5_000;

/** 429 bez nagłówka z czasem — nie pytamy przez minutę. Dłużej niż godzinę nie blokujemy (okno limitu to 1 h). */
const DEFAULT_RATE_LIMIT_SECONDS = 60;
const MAX_RATE_LIMIT_SECONDS = 60 * 60;

/** Karta tworzona asynchronicznie: po chwili jeszcze jeden odczyt członkostwa. */
const CARD_RETRY_DELAY_MS = 1_000;

/** Transakcji na stronę listy (maks. API) i najwięcej stron przy szukaniu po reason — każda strona to wywołanie. */
const TRANSACTIONS_PAGE_LIMIT = 100;
const MAX_TRANSACTION_PAGES = 3;

/** Dokument w loyalty_members z blokadą po 429 — wspólny dla wszystkich instancji (§3 „Budżet wywołań”). */
export const RATE_LIMIT_DOC_ID = "__rate_limit__";

type RateLimitDoc = { _id: string; blockedUntil: Date };

const globalForVoucherify = globalThis as typeof globalThis & { __voucherifyBlockedUntil?: number };

/** Tylko testy: zdejmuje blokadę po 429 z pamięci procesu (dokument w bazie czyści test). */
export function resetVoucherifyRateLimit(): void {
  globalForVoucherify.__voucherifyBlockedUntil = 0;
}

type VoucherifyConfig = { baseUrl: string; appId: string; secretKey: string; programId: string; cardDefinitionId: string };

/** Konfiguracja z env przy każdym wywołaniu (nie przy imporcie). Brak → niedostępne, bez wypisywania wartości. */
function config(): VoucherifyConfig {
  const read = (name: string) => process.env[name]?.trim() ?? "";
  const cfg = {
    baseUrl: (read("VOUCHERIFY_API_URL") || "https://api.voucherify.io").replace(/\/+$/, ""),
    appId: read("VOUCHERIFY_APP_ID"),
    secretKey: read("VOUCHERIFY_SECRET_KEY"),
    programId: read("VOUCHERIFY_PROGRAM_ID"),
    cardDefinitionId: read("VOUCHERIFY_CARD_DEFINITION_ID"),
  };
  const missing = Object.entries({
    VOUCHERIFY_APP_ID: cfg.appId,
    VOUCHERIFY_SECRET_KEY: cfg.secretKey,
    VOUCHERIFY_PROGRAM_ID: cfg.programId,
    VOUCHERIFY_CARD_DEFINITION_ID: cfg.cardDefinitionId,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    console.error(`[voucherify] Brak konfiguracji: ${missing.join(", ")}.`);
    throw new LoyaltyUnavailableError("Voucherify nie jest skonfigurowany.");
  }
  return cfg;
}

async function rateLimitCollection() {
  return (await getDb()).collection<RateLimitDoc>(LOYALTY_MEMBERS_COLLECTION);
}

/** Do końca blokady po 429 nie wołamy Voucherify wcale — ani z tego procesu, ani z innych instancji. */
async function assertNotRateLimited(): Promise<void> {
  const now = Date.now();
  let until = globalForVoucherify.__voucherifyBlockedUntil ?? 0;
  if (until <= now) {
    const doc = await (await rateLimitCollection()).findOne({ _id: RATE_LIMIT_DOC_ID });
    until = doc?.blockedUntil.getTime() ?? 0;
    globalForVoucherify.__voucherifyBlockedUntil = until;
  }
  if (until > now) {
    throw new LoyaltyUnavailableError("Voucherify: limit wywołań, czekamy.", {
      retryAfterSeconds: Math.ceil((until - now) / 1000),
    });
  }
}

/** Retry-After (sekundy albo data HTTP) albo X-Rate-Limit-Retry (sekundy). */
function retryAfterSeconds(res: Response): number {
  for (const name of ["retry-after", "x-rate-limit-retry"]) {
    const raw = res.headers.get(name)?.trim();
    if (!raw) continue;
    const seconds = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(Math.ceil(seconds), MAX_RATE_LIMIT_SECONDS);
  }
  return DEFAULT_RATE_LIMIT_SECONDS;
}

async function rememberRateLimit(seconds: number): Promise<void> {
  const until = Date.now() + seconds * 1000;
  globalForVoucherify.__voucherifyBlockedUntil = Math.max(globalForVoucherify.__voucherifyBlockedUntil ?? 0, until);
  try {
    await (await rateLimitCollection()).updateOne(
      { _id: RATE_LIMIT_DOC_ID },
      { $max: { blockedUntil: new Date(until) } },
      { upsert: true },
    );
  } catch (err) {
    // Blokada w procesie i tak działa; inne instancje dostaną własne 429.
    console.error("[voucherify] Nie udało się zapisać blokady po 429:", err);
  }
}

type VoucherifyResponse = { status: number; body: Record<string, unknown> | null };

/**
 * Jedno wywołanie Voucherify. label trafia do logów zamiast ścieżki (ścieżka ma e-mail). Kluczy nie logujemy.
 * Zwraca odpowiedź dla 2xx oraz dla statusów z `expected` (np. 404, 409); resztę zamienia na
 * LoyaltyUnavailableError. Dla POST-a timeout, zerwane połączenie i 5xx → uncertain: true.
 */
async function request(
  label: string,
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; expected?: number[] } = {},
): Promise<VoucherifyResponse> {
  const cfg = config();
  await assertNotRateLimited();
  const mayHaveApplied = method === "POST";

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: {
        "X-App-Id": cfg.appId,
        "X-App-Token": cfg.secretKey,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "błąd";
    console.error(`[voucherify] ${label}: brak odpowiedzi (${name}).`);
    throw new LoyaltyUnavailableError(`Voucherify ${label}: brak odpowiedzi.`, { uncertain: mayHaveApplied, cause: err });
  }

  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await res.json();
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }

  if (res.ok || options.expected?.includes(res.status)) {
    if (res.ok && body === null) {
      console.error(`[voucherify] ${label}: HTTP ${res.status} bez poprawnego JSON.`);
      throw new LoyaltyUnavailableError(`Voucherify ${label}: nieczytelna odpowiedź.`, { uncertain: mayHaveApplied });
    }
    return { status: res.status, body };
  }

  const key = typeof body?.key === "string" ? body.key : "";
  if (res.status === 429) {
    const seconds = retryAfterSeconds(res);
    console.error(`[voucherify] ${label}: 429 — nie wołamy Voucherify przez ${seconds} s.`);
    await rememberRateLimit(seconds);
    throw new LoyaltyUnavailableError(`Voucherify ${label}: limit wywołań.`, { retryAfterSeconds: seconds });
  }
  console.error(`[voucherify] ${label}: HTTP ${res.status}${key ? ` ${key}` : ""}.`);
  throw new LoyaltyUnavailableError(`Voucherify ${label}: HTTP ${res.status}${key ? ` ${key}` : ""}.`, {
    uncertain: mayHaveApplied && res.status >= 500,
  });
}

function programPath(cfg: VoucherifyConfig): string {
  return `/v2/loyalties/programs/${encodeURIComponent(cfg.programId)}`;
}

function cardPath(cfg: VoucherifyConfig, memberId: string, cardId: string): string {
  return `${programPath(cfg)}/members/${encodeURIComponent(memberId)}/cards/${encodeURIComponent(cardId)}`;
}

type CardInfo = { cardId: string; balance: number };

/** Z listy cards[] członka/członkostwa: karta naszego portfela (card_definition_id). Karta bez id → null. */
function ourCard(cards: unknown, cardDefinitionId: string): CardInfo | null {
  if (!Array.isArray(cards)) return null;
  for (const entry of cards) {
    const card = (entry as { card?: unknown } | null)?.card as
      | { id?: unknown; card_definition_id?: unknown; balance?: { points?: unknown } }
      | null
      | undefined;
    if (!card || card.card_definition_id !== cardDefinitionId) continue;
    if (typeof card.id !== "string" || !card.id) return null;
    const points = card.balance?.points;
    return { cardId: card.id, balance: typeof points === "number" ? points : 0 };
  }
  return null;
}

function memberIdOf(value: unknown): string | null {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === "string" && id ? id : null;
}

function asStatus(value: unknown): TransactionStatus | null {
  return value === "PENDING" || value === "PROCESSING" || value === "APPROVED" || value === "REJECTED" ? value : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function findMemberVoucherify(email: string): Promise<(MemberRef & { balance: number }) | null> {
  const cfg = config();
  // E-mail zawsze kodowany: testowe adresy mają „+” (delivered+jan@resend.dev).
  const { status, body } = await request(
    "findMember",
    "GET",
    `${programPath(cfg)}/memberships/${encodeURIComponent(email)}?identification_type=customer_source_id`,
    { expected: [404] },
  );
  if (status === 404) return null;
  const memberId = memberIdOf(body?.member);
  const card = ourCard(body?.cards, cfg.cardDefinitionId);
  if (!memberId || !card) {
    // Członek bez karty naszego portfela (albo karta jeszcze się tworzy) — saldo nieznane.
    console.error("[voucherify] findMember: członkostwo bez karty portfela.");
    throw new LoyaltyUnavailableError("Voucherify findMember: brak karty portfela.");
  }
  return { memberId, cardId: card.cardId, balance: card.balance };
}

const voucherifyClient: LoyaltyClient = {
  findMember: findMemberVoucherify,

  async createMember(email) {
    const cfg = config();
    // Klient musi istnieć, zanim zostanie członkiem programu. POST /v1/customers z source_id to upsert.
    await request("createCustomer", "POST", "/v1/customers", { body: { source_id: email, email } });
    const { status, body } = await request("createMember", "POST", `${programPath(cfg)}/members`, {
      body: { customer_identification: { type: "customer_source_id", customer_source_id: email } },
      expected: [409],
    });

    if (status === 409) {
      if (body?.key !== "member_already_exists") {
        console.error(`[voucherify] createMember: HTTP 409 ${String(body?.key ?? "")}.`);
        throw new LoyaltyUnavailableError("Voucherify createMember: konflikt.");
      }
      // Członek już jest (np. z panelu marketingu) — bez punktów powitalnych (§2).
      const existing = await findMemberVoucherify(email);
      if (!existing) throw new LoyaltyUnavailableError("Voucherify createMember: 409, ale członkostwa nie widać.");
      return { memberId: existing.memberId, cardId: existing.cardId, created: false };
    }

    const memberId = memberIdOf(body);
    if (!memberId) throw new LoyaltyUnavailableError("Voucherify createMember: odpowiedź bez id członka.");
    const card = ourCard(body?.cards, cfg.cardDefinitionId);
    if (card) return { memberId, cardId: card.cardId, created: true };

    // Karta tworzy się asynchronicznie — jeden odczyt członkostwa po chwili.
    await sleep(CARD_RETRY_DELAY_MS);
    const found = await findMemberVoucherify(email);
    if (!found) throw new LoyaltyUnavailableError("Voucherify createMember: karta jeszcze niegotowa.");
    return { memberId: found.memberId, cardId: found.cardId, created: true };
  },

  async addPoints(memberId, cardId, points, reason) {
    const cfg = config();
    const { body } = await request("addPoints", "POST", `${cardPath(cfg, memberId, cardId)}/points`, {
      body: { points, reason },
    });
    const transactionId = memberIdOf(body?.transaction);
    if (!transactionId) {
      // 2xx bez transakcji (np. NO_CHANGE) — nie wiemy, co z saldem; traktujemy jak niepewne.
      throw new LoyaltyUnavailableError("Voucherify addPoints: odpowiedź bez transakcji.", { uncertain: true });
    }
    return { transactionId };
  },

  async getTransaction(memberId, cardId, transactionId) {
    const cfg = config();
    const query = `filters[id][conditions][$is]=${encodeURIComponent(transactionId)}&limit=1`;
    const { body } = await request("getTransaction", "GET", `${cardPath(cfg, memberId, cardId)}/transactions?${query}`);
    const transaction = Array.isArray(body?.data) ? (body.data[0] as { id?: unknown; status?: unknown }) : undefined;
    const status = transaction?.id === transactionId ? asStatus(transaction.status) : null;
    if (!status) throw new LoyaltyUnavailableError("Voucherify getTransaction: nie ma takiej transakcji.");
    return { status };
  },

  async findTransactionByReason(memberId, cardId, reason, since) {
    const cfg = config();
    const base =
      `${cardPath(cfg, memberId, cardId)}/transactions?limit=${TRANSACTIONS_PAGE_LIMIT}&order=-id` +
      `&filters[created_at][conditions][$after]=${encodeURIComponent(since.toISOString())}`;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_TRANSACTION_PAGES; page++) {
      const path: string = cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;
      const { body } = await request("findTransactionByReason", "GET", path);
      const data = Array.isArray(body?.data) ? body.data : [];
      // Najnowsze pierwsze (order=-id) — pierwsza pasująca to ostatnia próba tej operacji.
      for (const item of data) {
        const t = item as { id?: unknown; status?: unknown; details?: { reason?: unknown; points?: { total?: unknown } } };
        const status = asStatus(t.status);
        if (t.details?.reason === reason && typeof t.id === "string" && status) {
          const total = t.details.points?.total;
          return { transactionId: t.id, status, points: typeof total === "number" ? total : 0 };
        }
      }
      const next = (body?.cursor as { next?: unknown } | null | undefined)?.next;
      if (typeof next !== "string" || !next) return null;
      cursor = next;
    }
    console.error(`[voucherify] findTransactionByReason: ponad ${MAX_TRANSACTION_PAGES} strony transakcji.`);
    throw new LoyaltyUnavailableError("Voucherify findTransactionByReason: za dużo transakcji, nie wiadomo.");
  },
};

// --- provider "memory" (testy, lokalnie) ---

type MemoryTransaction = { id: string; points: number; reason: string; status: TransactionStatus; at: Date };
type MemoryMember = MemberRef & { balance: number; transactions: MemoryTransaction[] };
type MemoryStore = { members: Map<string, MemoryMember>; seq: number };

const globalForLoyalty = globalThis as typeof globalThis & { __loyaltyMemory?: MemoryStore };

function store(): MemoryStore {
  return (globalForLoyalty.__loyaltyMemory ??= { members: new Map(), seq: 0 });
}

/** Tylko testy: czyści punkty w pamięci. */
export function resetMemoryLoyalty(): void {
  globalForLoyalty.__loyaltyMemory = { members: new Map(), seq: 0 };
}

function memberByIds(memberId: string, cardId: string): MemoryMember {
  for (const member of store().members.values()) {
    if (member.memberId === memberId && member.cardId === cardId) return member;
  }
  throw new LoyaltyUnavailableError(`Nie ma członka ${memberId} z kartą ${cardId} (memory).`);
}

const memoryClient: LoyaltyClient = {
  async findMember(email) {
    const member = store().members.get(email);
    return member ? { memberId: member.memberId, cardId: member.cardId, balance: member.balance } : null;
  },
  async createMember(email) {
    const s = store();
    const existing = s.members.get(email);
    if (existing) return { memberId: existing.memberId, cardId: existing.cardId, created: false };
    const n = ++s.seq;
    const member: MemoryMember = { memberId: `lmbr_mem${n}`, cardId: `lcrd_mem${n}`, balance: 0, transactions: [] };
    s.members.set(email, member);
    return { memberId: member.memberId, cardId: member.cardId, created: true };
  },
  async addPoints(memberId, cardId, points, reason) {
    const member = memberByIds(memberId, cardId);
    // Jak nasz portfel w Voucherify: ujemne saldo niedozwolone → transakcja REJECTED.
    const rejected = member.balance + points < 0;
    if (!rejected) member.balance += points;
    const transaction: MemoryTransaction = {
      id: `lctx_mem${++store().seq}`,
      points,
      reason,
      status: rejected ? "REJECTED" : "APPROVED",
      at: new Date(),
    };
    member.transactions.push(transaction);
    return { transactionId: transaction.id };
  },
  async getTransaction(memberId, cardId, transactionId) {
    const transaction = memberByIds(memberId, cardId).transactions.find((t) => t.id === transactionId);
    if (!transaction) throw new LoyaltyUnavailableError(`Nie ma transakcji ${transactionId} (memory).`);
    return { status: transaction.status };
  },
  async findTransactionByReason(memberId, cardId, reason, since) {
    const found = memberByIds(memberId, cardId)
      .transactions.filter((t) => t.reason === reason && t.at >= since)
      .at(-1);
    return found ? { transactionId: found.id, status: found.status, points: found.points } : null;
  },
};
