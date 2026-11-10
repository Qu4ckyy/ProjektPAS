// Klient Voucherify Loyalty Hub v2 — CONTRACT.md §1, §3 „Operacje na punktach”, §6, D12, D21. Właściciel: Eryk.
// STUB — implementuje Eryk: provider "voucherify" (REST v2 + /v1/customers). Provider "memory" jest gotowy
// do testów i lokalnej pracy: zachowuje się jak nasz portfel (od razu APPROVED, bez ujemnego salda).

export type TransactionStatus = "PENDING" | "PROCESSING" | "APPROVED" | "REJECTED";

export type MemberRef = { memberId: string; cardId: string };

export interface LoyaltyClient {
  /** Członkostwo e-maila w programie z saldem karty naszego portfela; brak → null. */
  findMember(email: string): Promise<(MemberRef & { balance: number }) | null>;
  /** Upsert klienta + członek programu; już był (409) → istniejący z created: false. */
  createMember(email: string): Promise<MemberRef & { created: boolean }>;
  /** Zmiana punktów (ujemne = pobranie) → transakcja, zwykle jeszcze PENDING (v2 jest asynchroniczne). */
  addPoints(memberId: string, cardId: string, points: number, reason: string): Promise<{ transactionId: string }>;
  getTransaction(memberId: string, cardId: string, transactionId: string): Promise<{ status: TransactionStatus }>;
  /** Nasza operacja po unikalnym reason (spend-<id>, earn-<id>, …) z transakcji od `since`. */
  findTransactionByReason(
    memberId: string,
    cardId: string,
    reason: string,
    since: Date,
  ): Promise<{ transactionId: string; status: TransactionStatus } | null>;
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

// STUB — implementuje Eryk (PROMPTY E3, punkt 1).
const voucherifyClient: LoyaltyClient = {
  async findMember() {
    throw new LoyaltyUnavailableError("Klient Voucherify jeszcze niegotowy (STUB).");
  },
  async createMember() {
    throw new LoyaltyUnavailableError("Klient Voucherify jeszcze niegotowy (STUB).");
  },
  async addPoints() {
    throw new LoyaltyUnavailableError("Klient Voucherify jeszcze niegotowy (STUB).");
  },
  async getTransaction() {
    throw new LoyaltyUnavailableError("Klient Voucherify jeszcze niegotowy (STUB).");
  },
  async findTransactionByReason() {
    throw new LoyaltyUnavailableError("Klient Voucherify jeszcze niegotowy (STUB).");
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
    return found ? { transactionId: found.id, status: found.status } : null;
  },
};
