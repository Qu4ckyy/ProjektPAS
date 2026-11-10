// Atrapa Voucherify Loyalty Hub v2 dla testów: mock fetch z tymi samymi ścieżkami i kształtami
// odpowiedzi co prawdziwe API (docs.voucherify.io), stanem w pamięci i wstrzykiwaniem awarii.
// Żaden test nie woła prawdziwego Voucherify (CONTRACT.md §6).
import { vi } from "vitest";

export const FAKE_PROGRAM_ID = "lprg_0000000000000000aa";
export const FAKE_CARD_DEFINITION_ID = "lcdef_000000000000000bb";
/** Druga karta (inny portfel) — klient musi wybrać naszą po card_definition_id. */
const OTHER_CARD_DEFINITION_ID = "lcdef_000000000000000cc";

export const FAKE_ENV = {
  LOYALTY_PROVIDER: "voucherify",
  VOUCHERIFY_API_URL: "https://fake.voucherify.test",
  VOUCHERIFY_APP_ID: "app-id-unit-only",
  VOUCHERIFY_SECRET_KEY: "secret-unit-only-never-logged",
  VOUCHERIFY_PROGRAM_ID: FAKE_PROGRAM_ID,
  VOUCHERIFY_CARD_DEFINITION_ID: FAKE_CARD_DEFINITION_ID,
};

export type Op =
  | "findMember"
  | "createCustomer"
  | "createMember"
  | "addPoints"
  | "getTransaction"
  | "listTransactions";

type FaultKind =
  /** Zmiana dochodzi do Voucherify, ale odpowiedź ginie (timeout po wysłaniu). */
  | "timeout-after"
  /** Timeout, zanim cokolwiek doszło. */
  | "timeout-before"
  | "429"
  | "500"
  | "423";

type Transaction = {
  id: string;
  points: number;
  reason: string;
  /** Wynik po przetworzeniu; do tego czasu saldo bez zmian (v2 jest asynchroniczne). */
  finalStatus: "APPROVED" | "REJECTED" | null;
  /** Ile odczytów jeszcze pokaże PENDING. */
  pendingReads: number;
  createdAt: Date;
};

type Member = { memberId: string; cardId: string; otherCardId: string; balance: number; transactions: Transaction[] };

export class FakeVoucherify {
  readonly calls: { op: Op; method: string; url: string; headers: Headers; body: unknown }[] = [];
  readonly customers = new Set<string>();
  readonly members = new Map<string, Member>();
  /** Ile odczytów każda nowa transakcja jest PENDING (0 = od razu wynik). */
  pendingReads = 0;
  /** createMember zwraca członka bez karty (karta tworzona asynchronicznie). */
  cardAsync = false;
  private faults: { op: Op; kind: FaultKind; retryAfter?: string }[] = [];
  private seq = 0;

  readonly fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => this.handle(input, init));

  /** Następne wywołanie tej operacji zawiedzie. Kolejne fault-y tej samej operacji — po kolei. */
  fail(op: Op, kind: FaultKind, options: { retryAfter?: string; times?: number } = {}): this {
    for (let i = 0; i < (options.times ?? 1); i++) this.faults.push({ op, kind, retryAfter: options.retryAfter });
    return this;
  }

  count(op?: Op): number {
    return op ? this.calls.filter((c) => c.op === op).length : this.calls.length;
  }

  balanceOf(email: string): number | undefined {
    return this.members.get(email)?.balance;
  }

  transactionsOf(email: string, reason?: string): Transaction[] {
    return (this.members.get(email)?.transactions ?? []).filter((t) => reason === undefined || t.reason === reason);
  }

  /** Członek założony „w panelu marketingu” — bez naszych punktów powitalnych. */
  addMemberFromPanel(email: string, balance = 0): Member {
    this.customers.add(email);
    const member = this.newMember(balance);
    this.members.set(email, member);
    return member;
  }

  private newMember(balance: number): Member {
    const n = ++this.seq;
    const hex = n.toString(16).padStart(18, "0");
    return { memberId: `lmbr_${hex}`, cardId: `lcrd_${hex}`, otherCardId: `lcrd_f${hex.slice(1)}`, balance, transactions: [] };
  }

  private cardsJson(member: Member, withCard = true) {
    return [
      {
        member_role: "OWNER",
        card: { id: member.otherCardId, card_definition_id: OTHER_CARD_DEFINITION_ID, balance: { points: 99999, pending_points: 0 }, object: "card" },
        object: "member_card",
      },
      {
        member_role: "OWNER",
        card: withCard
          ? { id: member.cardId, card_definition_id: FAKE_CARD_DEFINITION_ID, code: null, balance: { points: member.balance, pending_points: 0 }, object: "card" }
          : null,
        object: "member_card",
      },
    ];
  }

  private memberByCard(memberId: string, cardId: string): Member | undefined {
    for (const member of this.members.values()) if (member.memberId === memberId && member.cardId === cardId) return member;
    return undefined;
  }

  /** Przetworzenie transakcji, których czas minął: dopiero wtedy saldo się zmienia (ujemne → REJECTED). */
  private process(member: Member): void {
    for (const t of member.transactions) {
      if (t.finalStatus || t.pendingReads > 0) continue;
      t.finalStatus = member.balance + t.points < 0 ? "REJECTED" : "APPROVED";
      if (t.finalStatus === "APPROVED") member.balance += t.points;
    }
  }

  private transactionJson(t: Transaction, read: boolean) {
    const status = t.pendingReads > 0 || !t.finalStatus ? "PENDING" : t.finalStatus;
    if (read && t.pendingReads > 0) t.pendingReads--;
    return {
      id: t.id,
      type: t.points >= 0 ? "ADMIN_CREDIT" : "ADMIN_DEBIT",
      details: { reason: t.reason, rejection: null, metadata: {}, points: { total: t.points } },
      status,
      created_at: t.createdAt.toISOString(),
      object: "card_transaction",
    };
  }

  private async handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const path = url.pathname.split("/").map(decodeURIComponent);
    const op = this.opOf(method, path, url);
    this.calls.push({ op, method, url: url.href, headers: new Headers(init?.headers), body });

    const index = this.faults.findIndex((f) => f.op === op);
    const fault = index >= 0 ? this.faults.splice(index, 1)[0] : undefined;
    if (fault?.kind === "timeout-before") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (fault?.kind === "429") {
      return json(429, { code: 429, key: "too_many_requests", message: "Too many requests" }, fault.retryAfter ? { "Retry-After": fault.retryAfter } : {});
    }
    if (fault?.kind === "500") return json(500, { code: 500, key: "api_error", message: "Internal error" });
    if (fault?.kind === "423") return json(423, { code: 423, key: "non_active_program", message: "Program is not active" });

    const response = this.route(op, method, path, url, body);
    if (fault?.kind === "timeout-after") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return response;
  }

  private opOf(method: string, path: string[], url: URL): Op {
    // ["", "v2", "loyalties", "programs", p, "members", m, "cards", c, "points" | "transactions"]
    if (path[1] === "v1" && path[2] === "customers") return "createCustomer";
    if (path[5] === "memberships") return "findMember";
    if (path[5] === "members" && path.length === 6) return "createMember";
    if (path[9] === "points") return "addPoints";
    if (path[9] === "transactions") return url.searchParams.has("filters[id][conditions][$is]") ? "getTransaction" : "listTransactions";
    throw new Error(`FakeVoucherify: nieznane wywołanie ${method} ${url.pathname}`);
  }

  private route(op: Op, method: string, path: string[], url: URL, body?: Record<string, unknown>): Response {
    if (op !== "createCustomer" && path[4] !== FAKE_PROGRAM_ID) {
      return json(404, { code: 404, key: "not_found", resource_type: "program" });
    }
    switch (op) {
      case "createCustomer": {
        this.customers.add(String(body?.source_id));
        return json(200, { id: `cust_${String(body?.source_id).length}`, source_id: body?.source_id, object: "customer" });
      }
      case "findMember": {
        if (url.searchParams.get("identification_type") !== "customer_source_id") return json(400, { key: "invalid_query_params" });
        const member = this.members.get(path[6]);
        if (!member) return json(404, { code: 404, key: "not_found", resource_type: this.customers.has(path[6]) ? "member" : "customer" });
        this.process(member);
        return json(200, {
          member: { id: member.memberId, status: "ACTIVE", object: "member" },
          program: { id: FAKE_PROGRAM_ID, status: "ACTIVE", object: "program" },
          cards: this.cardsJson(member),
          object: "membership",
        });
      }
      case "createMember": {
        const identification = body?.customer_identification as { type?: string; customer_source_id?: string } | undefined;
        const email = identification?.customer_source_id ?? "";
        if (identification?.type !== "customer_source_id" || !this.customers.has(email)) {
          return json(404, { code: 404, key: "not_found", resource_type: "customer" });
        }
        if (this.members.has(email)) {
          return json(409, { code: 409, key: "member_already_exists", message: "Member already exists" });
        }
        const member = this.newMember(0);
        this.members.set(email, member);
        return json(200, { id: member.memberId, status: "ACTIVE", object: "member", cards: this.cardsJson(member, !this.cardAsync) });
      }
      case "addPoints": {
        const member = this.memberByCard(path[6], path[8]);
        if (!member) return json(404, { code: 404, key: "not_found", resource_type: "card" });
        const n = ++this.seq;
        const t: Transaction = {
          id: `lctx_${n.toString(16).padStart(18, "0")}`,
          points: Number(body?.points),
          reason: String(body?.reason ?? ""),
          finalStatus: null,
          pendingReads: this.pendingReads,
          createdAt: new Date(),
        };
        member.transactions.push(t);
        this.process(member);
        // Odpowiedź POST-a zawsze z PENDING — wynik dopiero na liście transakcji (§1).
        return json(200, { transaction: { ...this.transactionJson(t, false), status: "PENDING" }, status: "TRANSACTION_CREATED" });
      }
      case "getTransaction": {
        const member = this.memberByCard(path[6], path[8]);
        const id = url.searchParams.get("filters[id][conditions][$is]");
        const t = member?.transactions.find((x) => x.id === id);
        const data = t ? [this.transactionJson(t, true)] : [];
        if (member) this.process(member);
        return json(200, { data, cursor: null, object: "list" });
      }
      case "listTransactions": {
        const member = this.memberByCard(path[6], path[8]);
        if (!member) return json(404, { code: 404, key: "not_found", resource_type: "card" });
        const after = url.searchParams.get("filters[created_at][conditions][$after]");
        const list = member.transactions
          .filter((t) => !after || t.createdAt > new Date(after))
          .reverse()
          .map((t) => this.transactionJson(t, true));
        this.process(member);
        return json(200, { data: list, cursor: null, object: "list" });
      }
    }
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
