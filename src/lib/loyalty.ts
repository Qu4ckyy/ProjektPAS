// Konto punktowe klienta (karta A) — CONTRACT.md §0a D12–D14, D17, D18, D20, §2 loyalty_members, §3, §6. Właściciel: Eryk.
// Każda operacja w Voucherify startuje dopiero po atomowym zajęciu kroku w Mongo (kto nie wygrał, nie woła),
// a ponowienie zawsze najpierw szuka naszego reason na liście transakcji karty — v2 nie ma kluczy idempotencji.
import { ObjectId, type Collection, type Filter } from "mongodb";
import { runAfterResponse } from "@/lib/after";
import { getDb, isDuplicateKeyError, LOYALTY_MEMBERS_COLLECTION, RESERVATIONS_COLLECTION } from "@/lib/db";
import { WELCOME_POINTS } from "@/lib/points";
import type { LoyaltyMember, LoyaltyStep, Reservation } from "@/lib/types";
import { isReservationId, normalizeEmail } from "@/lib/validation";
import {
  getLoyaltyClient,
  LoyaltyUnavailableError,
  type FoundTransaction,
  type LoyaltyClient,
  type MemberRef,
} from "@/lib/voucherify";

export { normalizeEmail };

export type ApplyPointsResult = "done" | "rejected" | "retry";

/** Czasy odpytywania i czekania. Mutowalne tylko w testach (tests/helpers.ts skraca odpytywanie). */
export const loyaltyTiming = {
  /** Po pobraniu i punktach powitalnych pytamy o APPROVED po 0,5 / 1 / 1,5 s (razem ~4 s z wywołaniami). */
  approvalPollMs: [500, 1_000, 1_500],
  /** Przegrany zakładania karty czeka tyle na zwycięzcę, potem 503. */
  memberWaitMs: 5_000,
  memberWaitStepMs: 250,
};

/** Saldo z pamięci podręcznej: karta 30 s, „brak karty” 10 min (§2, D20). */
const BALANCE_TTL_MS = 30_000;
const ABSENT_TTL_MS = 10 * 60_000;

/** Krok pending (i zakładanie karty) dłużej niż tyle = przerwany, np. padła funkcja na Vercelu (Z54). */
const STALE_STEP_MS = 2 * 60_000;

/** Blokada wydawania punktów jednego e-maila (Z36). */
const SPEND_LOCK_MS = 15_000;

/** Zwrot punktów dopiero 30 s po expiresAt — D8 przyjmuje płatność do 10 s po czasie (D17). */
const SETTLE_AFTER_EXPIRY_MS = 30_000;

/** Ponowienie z GET nie częściej niż co minutę — strona sukcesu odpytuje co 2 s, a limit to 100/h. */
const RETRY_BACKOFF_MS = 60_000;

/** Szukając naszego reason, patrzymy na transakcje z ostatnich 24 h (§3 „Operacje na punktach”). */
const TRANSACTION_LOOKBACK_MS = 24 * 60 * 60_000;

/** Ile zaległych operacji na jeden przebieg crona i ile zwrotów jednego e-maila naraz — budżet 100/h. */
const RETRY_BATCH = 20;
const EMAIL_SETTLE_BATCH = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function reservationsCollection(): Promise<Collection<Reservation>> {
  return (await getDb()).collection<Reservation>(RESERVATIONS_COLLECTION);
}

async function membersCollection(): Promise<Collection<LoyaltyMember>> {
  return (await getDb()).collection<LoyaltyMember>(LOYALTY_MEMBERS_COLLECTION);
}

// --- Pamięć podręczna salda (loyalty_members) ---

/** Członek znaleziony w Voucherify: zapamiętaj kartę i saldo. Zakładanej właśnie karty nie ruszamy. */
async function rememberMember(email: string, member: MemberRef & { balance: number }): Promise<void> {
  const members = await membersCollection();
  const now = new Date();
  try {
    await members.updateOne(
      { _id: email, status: { $ne: "creating" } },
      {
        $set: {
          status: "ready",
          memberId: member.memberId,
          cardId: member.cardId,
          balance: member.balance,
          balanceAt: now,
          checkedAt: now,
        },
      },
      { upsert: true },
    );
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    await members.updateOne({ _id: email, status: "creating" }, { $set: { balance: member.balance, balanceAt: now } });
  }
}

/** E-mail bez karty: zapamiętaj na 10 min. welcome zostaje — punkty powitalne raz na e-mail (Z51). */
async function rememberAbsent(email: string): Promise<void> {
  const members = await membersCollection();
  try {
    await members.updateOne(
      { _id: email, status: { $ne: "creating" } },
      { $set: { status: "absent", memberId: null, cardId: null, checkedAt: new Date() }, $unset: { balance: "", balanceAt: "" } },
      { upsert: true },
    );
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }
}

/** Po naszej zmianie punktów: saldo w pamięci to tylko szacunek, następny odczyt pyta Voucherify. */
async function invalidateBalance(email: string, delta: number): Promise<void> {
  await (await membersCollection()).updateOne({ _id: email }, [
    {
      $set: {
        balance: { $cond: [{ $eq: [{ $type: "$balance" }, "missing"] }, "$$REMOVE", { $add: ["$balance", delta] }] },
        balanceAt: "$$REMOVE",
      },
    },
  ]);
}

// --- Saldo ---

/**
 * Saldo dla GET /api/loyalty i podpowiedzi punktów (D20): najpierw zaległe zwroty i naliczenia tego
 * e-maila, potem pamięć podręczna albo jedno findMember. Voucherify niedostępny → ostatnie znane saldo,
 * a bez niego LoyaltyUnavailableError.
 */
export async function getPoints(email: string): Promise<number> {
  const normalized = normalizeEmail(email);
  await settleLoyalty({ email: normalized });
  await retryEarnsFor(normalized);

  const doc = await (await membersCollection()).findOne({ _id: normalized });
  const now = Date.now();
  if (doc?.status === "ready" && doc.balance !== undefined && doc.balanceAt && now - doc.balanceAt.getTime() < BALANCE_TTL_MS) {
    return doc.balance;
  }
  if (doc?.status === "absent" && now - doc.checkedAt.getTime() < ABSENT_TTL_MS) return WELCOME_POINTS;

  try {
    return await getFreshBalance(normalized);
  } catch (err) {
    if (!(err instanceof LoyaltyUnavailableError)) throw err;
    if (doc?.balance !== undefined) return doc.balance;
    if (doc?.status === "absent") return WELCOME_POINTS;
    throw err;
  }
}

/** Saldo prosto z Voucherify; e-mail bez karty ma 1000 i karty NIE zakładamy (D14). */
export async function getFreshBalance(email: string): Promise<number> {
  const normalized = normalizeEmail(email);
  const member = await getLoyaltyClient().findMember(normalized);
  if (!member) {
    await rememberAbsent(normalized);
    return WELCOME_POINTS;
  }
  await rememberMember(normalized, member);
  return member.balance;
}

// --- Członek programu i punkty powitalne (D14, Z51) ---

/** Atomowe zajęcie zakładania karty: brak dokumentu, absent albo przerwane creating → creating. */
async function claimCreating(members: Collection<LoyaltyMember>, email: string): Promise<LoyaltyMember | null> {
  const now = new Date();
  try {
    return await members.findOneAndUpdate(
      {
        _id: email,
        $or: [
          { status: "absent" },
          { status: "creating", checkedAt: { $lt: new Date(now.getTime() - STALE_STEP_MS) } },
          { status: "ready", $or: [{ memberId: null }, { cardId: null }] },
        ],
      },
      { $set: { status: "creating", checkedAt: now }, $setOnInsert: { memberId: null, cardId: null } },
      { upsert: true, returnDocument: "after" },
    );
  } catch (err) {
    // Dokument jest i nie pasuje (ready albo świeże creating) — wygrał ktoś inny.
    if (isDuplicateKeyError(err)) return null;
    throw err;
  }
}

/** Zwycięzca zakładania: członek w Voucherify, potem 1000 powitalnych z czekaniem na APPROVED, na końcu ready. */
async function createMemberWithWelcome(
  members: Collection<LoyaltyMember>,
  email: string,
  claimed: LoyaltyMember,
): Promise<MemberRef> {
  const client = getLoyaltyClient();
  let memberId = claimed.memberId;
  let cardId = claimed.cardId;
  let welcome = claimed.welcome;
  try {
    if (!memberId || !cardId) {
      const created = await client.createMember(email);
      memberId = created.memberId;
      cardId = created.cardId;
      // 409 (członek z panelu) → bez powitalnych. welcome: pending z przerwanej próby → to my go założyliśmy.
      if ((created.created || welcome === "pending") && welcome !== "done") welcome = "pending";
      await members.updateOne(
        { _id: email, status: "creating" },
        { $set: { memberId, cardId, ...(welcome ? { welcome } : {}), checkedAt: new Date() } },
      );
    }
    if (welcome === "pending") {
      // Przejęta próba mogła już wysłać punkty powitalne — wtedy najpierw szukamy ich po reason.
      const result = await applyToCard(client, { memberId, cardId }, WELCOME_POINTS, `welcome-${email}`, {
        waitForApproval: true,
        checkFirst: claimed.welcome === "pending",
      });
      if (result !== "done") throw new LoyaltyUnavailableError(`Punkty powitalne ${result === "rejected" ? "odrzucone" : "jeszcze niepotwierdzone"}.`);
      welcome = "done";
    }
    await members.updateOne(
      { _id: email, status: "creating" },
      { $set: { status: "ready", memberId, cardId, ...(welcome ? { welcome } : {}), checkedAt: new Date() }, $unset: { balanceAt: "" } },
    );
    return { memberId, cardId };
  } catch (err) {
    const uncertainCreate = !memberId && err instanceof LoyaltyUnavailableError && err.uncertain;
    // Zwolnij od razu (checkedAt w przeszłości) — następna próba przejmie i sprawdzi po reason.
    // Niepewne założenie członka: mogliśmy go założyć my, więc przy 409 dalej należą się powitalne.
    await members
      .updateOne(
        { _id: email, status: "creating" },
        { $set: { checkedAt: new Date(0), ...(uncertainCreate && claimed.welcome !== "done" ? { welcome: "pending" } : {}) } },
      )
      .catch(() => {});
    throw err;
  }
}

/**
 * Członek programu z kartą; nowy dostaje 1000 punktów powitalnych dokładnie raz (Z51). Przy równoległych
 * pierwszych operacjach zakłada jeden, reszta czeka do kilku sekund na ready, potem LoyaltyUnavailableError.
 */
export async function ensureMember(email: string): Promise<MemberRef> {
  const normalized = normalizeEmail(email);
  const members = await membersCollection();
  const deadline = Date.now() + loyaltyTiming.memberWaitMs;
  for (;;) {
    const doc = await members.findOne({ _id: normalized });
    if (doc?.status === "ready" && doc.memberId && doc.cardId) return { memberId: doc.memberId, cardId: doc.cardId };
    const claimed = await claimCreating(members, normalized);
    if (claimed) return createMemberWithWelcome(members, normalized, claimed);
    if (Date.now() >= deadline) throw new LoyaltyUnavailableError("Trwa zakładanie karty tego klienta.");
    await sleep(loyaltyTiming.memberWaitStepMs);
  }
}

// --- Operacje na punktach (§3 „Operacje na punktach”, Z44, Z55) ---

type ApplyOptions = { waitForApproval: boolean; checkFirst: boolean };

/** Po APPROVED pytamy kilka razy z przerwami; dalej PENDING → retry (następna próba sprawdzi po reason). */
async function waitForApproval(client: LoyaltyClient, ref: MemberRef, transactionId: string): Promise<ApplyPointsResult> {
  for (const delay of loyaltyTiming.approvalPollMs) {
    await sleep(delay);
    try {
      const { status } = await client.getTransaction(ref.memberId, ref.cardId, transactionId);
      if (status === "APPROVED") return "done";
      if (status === "REJECTED") return "rejected";
    } catch (err) {
      if (err instanceof LoyaltyUnavailableError) return "retry";
      throw err;
    }
  }
  return "retry";
}

/** Wynik dla transakcji znalezionej po reason; null = trzeba wysłać (brak albo REJECTED). */
async function resolveFound(
  client: LoyaltyClient,
  ref: MemberRef,
  found: FoundTransaction | null,
  points: number,
  options: ApplyOptions,
): Promise<ApplyPointsResult | null> {
  if (!found || found.status === "REJECTED") return null;
  if (found.points !== points) {
    // Ten sam reason z inną liczbą punktów (pobranie po zmianie wyboru klienta) — drugiego nie wysyłamy.
    console.error(`[loyalty] Transakcja ${found.transactionId}: ${found.points} pkt zamiast ${points} — wstrzymuję.`);
    return "retry";
  }
  if (found.status === "APPROVED" || !options.waitForApproval) return "done";
  return waitForApproval(client, ref, found.transactionId);
}

/** Zmiana punktów na znanej karcie z unikalnym reason. Ponowienie i niepewny POST → najpierw szukanie po reason. */
async function applyToCard(
  client: LoyaltyClient,
  ref: MemberRef,
  points: number,
  reason: string,
  options: ApplyOptions,
): Promise<ApplyPointsResult> {
  const since = () => new Date(Date.now() - TRANSACTION_LOOKBACK_MS);
  if (options.checkFirst) {
    const found = await client.findTransactionByReason(ref.memberId, ref.cardId, reason, since());
    const resolved = await resolveFound(client, ref, found, points, options);
    if (resolved) return resolved;
  }

  let transactionId: string;
  try {
    ({ transactionId } = await client.addPoints(ref.memberId, ref.cardId, points, reason));
  } catch (err) {
    if (!(err instanceof LoyaltyUnavailableError) || !err.uncertain) throw err;
    // Nie wiadomo, czy doszło (timeout, zerwane połączenie) — sprawdzamy od razu (Z44).
    try {
      const found = await client.findTransactionByReason(ref.memberId, ref.cardId, reason, since());
      return (await resolveFound(client, ref, found, points, options)) ?? "retry";
    } catch (checkErr) {
      if (checkErr instanceof LoyaltyUnavailableError) return "retry";
      throw checkErr;
    }
  }
  // Dodanie punktów portfel zawsze przyjmuje — liczy się 2xx. Pobranie dopiero po APPROVED (Z55).
  if (!options.waitForApproval) return "done";
  return waitForApproval(client, ref, transactionId);
}

/** Zmiana punktów klienta (zakłada kartę przez ensureMember) i unieważnienie salda w pamięci po sukcesie. */
async function applyPointsTo(email: string, points: number, reason: string, options: ApplyOptions): Promise<ApplyPointsResult> {
  const normalized = normalizeEmail(email);
  const ref = await ensureMember(normalized);
  const result = await applyToCard(getLoyaltyClient(), ref, points, reason, options);
  if (result === "done") await invalidateBalance(normalized, points);
  return result;
}

/**
 * Czy ta operacja była już próbowana: reason spend/refund/earn-<id> → licznik prób kroku w rezerwacji.
 * Nieznany reason → tak (bezpieczniej sprawdzić niż pobrać dwa razy).
 */
async function attemptedBefore(reason: string): Promise<boolean> {
  const match = /^(spend|refund|earn)-([0-9a-f]{24})$/.exec(reason);
  if (!match) return true;
  const [, step, id] = match as unknown as [string, "spend" | "refund" | "earn", string];
  const doc = await (await reservationsCollection()).findOne(
    { _id: new ObjectId(id) },
    { projection: { [`loyalty.${step}`]: 1 } },
  );
  return (doc?.loyalty?.[step]?.attempts ?? 0) > 1;
}

/**
 * Zmiana punktów z unikalnym reason (spend-<id>, refund-<id>, earn-<id>). waitForApproval: pobranie
 * liczy się dopiero po APPROVED (Z55). Ponowienie (krok z drugą próbą) najpierw szuka transakcji po
 * reason — nigdy nie pobiera dwa razy (Z44). Voucherify niedostępny → LoyaltyUnavailableError.
 */
export async function applyPoints(
  email: string,
  points: number,
  reason: string,
  options: { waitForApproval: boolean },
): Promise<ApplyPointsResult> {
  return applyPointsTo(email, points, reason, { ...options, checkFirst: await attemptedBefore(reason) });
}

// --- Blokada wydawania (Z36) ---

const globalForLocks = globalThis as typeof globalThis & { __spendLocks?: Map<string, Date> };
const heldLocks = (globalForLocks.__spendLocks ??= new Map());

/** Blokada wydawania punktów tego e-maila na 15 s — atomowo; zajęta → false (Z36). */
export async function acquireSpendLock(email: string): Promise<boolean> {
  const _id = normalizeEmail(email);
  const now = new Date();
  const until = new Date(now.getTime() + SPEND_LOCK_MS);
  try {
    await (await membersCollection()).updateOne(
      { _id, $or: [{ spendLockUntil: { $exists: false } }, { spendLockUntil: { $lte: now } }] },
      {
        $set: { spendLockUntil: until },
        // Nowy dokument jak „nie sprawdzaliśmy jeszcze” — saldo i tak przyjdzie z Voucherify.
        $setOnInsert: { status: "absent", memberId: null, cardId: null, checkedAt: new Date(0) },
      },
      { upsert: true },
    );
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
  heldLocks.set(_id, until);
  return true;
}

/** Zdejmuje tylko własną blokadę — wygasłą i przejętą przez kogoś innego zostawia. */
export async function releaseSpendLock(email: string): Promise<void> {
  const _id = normalizeEmail(email);
  const until = heldLocks.get(_id);
  heldLocks.delete(_id);
  await (await membersCollection()).updateOne(until ? { _id, spendLockUntil: until } : { _id }, {
    $unset: { spendLockUntil: "" },
  });
}

// --- Kroki refund i earn w rezerwacji ---

type StepName = "refund" | "earn";

/** Koniec kroku — tylko jeśli to nadal nasze zajęcie (ta sama próba), żeby nie nadpisać przejętego. */
async function finishStep(id: ObjectId, step: StepName | "spend", attempts: number, status: LoyaltyStep["status"]): Promise<void> {
  await (await reservationsCollection()).updateOne(
    { _id: id, [`loyalty.${step}.status`]: "pending", [`loyalty.${step}.attempts`]: attempts },
    { $set: { [`loyalty.${step}.status`]: status, [`loyalty.${step}.at`]: new Date() } },
  );
}

/** Ponowienie albo przerwane pending; z GET dopiero po RETRY_BACKOFF_MS od ostatniej próby. */
function retryableStep(step: StepName, now: number, ignoreBackoff: boolean): Filter<Reservation>[] {
  return [
    { [`loyalty.${step}.status`]: "retry", ...(ignoreBackoff ? {} : { [`loyalty.${step}.at`]: { $lt: new Date(now - RETRY_BACKOFF_MS) } }) },
    { [`loyalty.${step}.status`]: "pending", [`loyalty.${step}.at`]: { $lt: new Date(now - STALE_STEP_MS) } },
  ];
}

/** Zajęcie kroku: pending, at teraz, attempts + 1, points z rezerwacji. */
function claimStep(step: StepName, now: Date, pointsField: "$pointsUsed" | "$pointsEarned") {
  return [
    {
      $set: {
        [`loyalty.${step}`]: {
          status: "pending",
          points: { $ifNull: [pointsField, { $ifNull: [`$loyalty.${step}.points`, 0] }] },
          at: now,
          attempts: { $add: [{ $ifNull: [`$loyalty.${step}.attempts`, 0] }, 1] },
        },
      },
    },
  ];
}

/** Wykonanie zajętego kroku w Voucherify: done / retry / failed (dodania portfel nie odrzuca). */
async function runStep(doc: Reservation, step: StepName, reason: string): Promise<boolean> {
  const claimed = doc.loyalty?.[step];
  if (!claimed) return false;
  let result: ApplyPointsResult;
  try {
    result =
      claimed.points > 0
        ? await applyPointsTo(doc.email, claimed.points, reason, { waitForApproval: false, checkFirst: claimed.attempts > 1 })
        : "done";
  } catch (err) {
    if (!(err instanceof LoyaltyUnavailableError)) throw err;
    console.error(`[loyalty] ${reason}: Voucherify niedostępny, ponowimy później.`, err.message);
    result = "retry";
  }
  if (result === "rejected") console.error(`[loyalty] ${reason}: Voucherify odrzucił dodanie punktów.`);
  await finishStep(doc._id, step, claimed.attempts, result === "done" ? "done" : result === "rejected" ? "failed" : "retry");
  return result === "done";
}

// --- Zwrot punktów (D17, Z39, Z40) ---

/**
 * Atomowo zamyka do `limit` rezerwacji z pobranymi punktami, które nie zostały opłacone: status expired,
 * active false i refund: pending. Od tej chwili acceptPayment ich nie opłaci (warunek held + active),
 * więc spóźniona płatność dostaje zwrot pieniędzy, a nie bilet. Bierze też ponowienia i przerwane zwroty.
 */
async function claimRefunds(scope: Filter<Reservation>, limit: number, ignoreBackoff: boolean): Promise<Reservation[]> {
  const reservations = await reservationsCollection();
  const claimed: Reservation[] = [];
  while (claimed.length < limit) {
    const now = new Date();
    const doc = await reservations.findOneAndUpdate(
      {
        ...scope,
        "loyalty.spend.status": "done",
        status: { $ne: "paid" },
        $or: [
          {
            "loyalty.refund": { $exists: false },
            $or: [{ active: false }, { expiresAt: { $lt: new Date(now.getTime() - SETTLE_AFTER_EXPIRY_MS) } }],
          },
          ...retryableStep("refund", now.getTime(), ignoreBackoff),
        ],
      },
      [{ $set: { status: "expired", active: false } }, ...claimStep("refund", now, "$pointsUsed")],
      { returnDocument: "after" },
    );
    if (!doc) break;
    claimed.push(doc);
  }
  return claimed;
}

async function refundAll(docs: Reservation[]): Promise<number> {
  let refunded = 0;
  for (const doc of docs) {
    if (await runStep(doc, "refund", `refund-${doc._id.toHexString()}`)) refunded++;
  }
  return refunded;
}

/**
 * Zwrot punktów za nieopłacone rezerwacje (D17). Dla rezerwacji: zamknięcie od razu, wywołanie
 * Voucherify po odpowiedzi (after). Dla e-maila (odczyt salda): czeka na zwroty, żeby saldo je pokazało.
 */
export async function settleLoyalty(target: { reservationId: string } | { email: string }): Promise<void> {
  if ("reservationId" in target) {
    if (!isReservationId(target.reservationId)) return;
    const claimed = await claimRefunds({ _id: new ObjectId(target.reservationId) }, 1, false);
    if (claimed.length > 0) await runAfterResponse("loyalty:refund", () => refundAll(claimed));
    return;
  }
  const claimed = await claimRefunds({ email: normalizeEmail(target.email) }, EMAIL_SETTLE_BATCH, false);
  await refundAll(claimed);
}

// --- Punkty za zakup (D18, Z41) ---

/**
 * Zajęcie naliczenia: świeże pending od acceptPayment (attempts 0), ponowienie albo przerwane pending.
 * Wygrywa jeden — tylko on woła Voucherify, więc powtórzony webhook i GET nie naliczą drugi raz.
 */
async function claimEarn(scope: Filter<Reservation>, ignoreBackoff: boolean): Promise<Reservation | null> {
  const now = new Date();
  return (await reservationsCollection()).findOneAndUpdate(
    {
      ...scope,
      status: "paid",
      $or: [{ "loyalty.earn.status": "pending", "loyalty.earn.attempts": 0 }, ...retryableStep("earn", now.getTime(), ignoreBackoff)],
    },
    claimStep("earn", now, "$pointsEarned"),
    { returnDocument: "after" },
  );
}

/**
 * Naliczenie pointsEarned po opłaceniu (D18): +pointsEarned z reason earn-<id>, karta zakładana przy
 * pierwszym użyciu z 1000 powitalnymi. Voucherify niedostępny → earn: retry (bilet i tak jest).
 */
export async function earnForPurchase(reservationId: string): Promise<void> {
  if (!isReservationId(reservationId)) return;
  const doc = await claimEarn({ _id: new ObjectId(reservationId) }, false);
  if (doc) await runStep(doc, "earn", `earn-${reservationId}`);
}

/** Zaległe naliczenia jednego e-maila — przed odczytem salda, żeby je pokazało. */
async function retryEarnsFor(email: string): Promise<void> {
  for (let i = 0; i < EMAIL_SETTLE_BATCH; i++) {
    const doc = await claimEarn({ email }, false);
    if (!doc) return;
    await runStep(doc, "earn", `earn-${doc._id.toHexString()}`);
  }
}

// --- Dzienny cron (Z54) ---

/**
 * Pobranie punktów z niepewnym wynikiem (retry albo przerwane pending), którego już nikt nie dokończy:
 * rezerwacja wygasła albo klient zapłacił bez punktów. Sprawdzamy po reason, czy punkty jednak zeszły.
 * Nieopłacona → spend: done z tą liczbą punktów, a zwrot zrobi claimRefunds. Opłacona (punkty nie poszły
 * na bilet) → zwrot od razu. Nie zeszły → failed. Bez tego punkty mogłyby przepaść (Z44, Z54).
 */
async function resolveUncertainSpends(limit: number): Promise<void> {
  const reservations = await reservationsCollection();
  const members = await membersCollection();
  for (let i = 0; i < limit; i++) {
    const now = new Date();
    const doc = await reservations.findOneAndUpdate(
      {
        "loyalty.refund": { $exists: false },
        $and: [
          { $or: [{ status: "paid" }, { active: false }, { expiresAt: { $lt: new Date(now.getTime() - SETTLE_AFTER_EXPIRY_MS) } }] },
          {
            $or: [
              { "loyalty.spend.status": "retry" },
              { "loyalty.spend.status": "pending", "loyalty.spend.at": { $lt: new Date(now.getTime() - STALE_STEP_MS) } },
            ],
          },
        ],
      },
      [
        {
          $set: {
            "loyalty.spend.status": "pending",
            "loyalty.spend.at": now,
            "loyalty.spend.attempts": { $add: [{ $ifNull: ["$loyalty.spend.attempts", 0] }, 1] },
          },
        },
      ],
      { returnDocument: "after" },
    );
    if (!doc?.loyalty?.spend) return;
    const attempts = doc.loyalty.spend.attempts;
    const id = doc._id.toHexString();

    const member = await members.findOne({ _id: normalizeEmail(doc.email) });
    if (member?.status === "creating") {
      await finishStep(doc._id, "spend", attempts, "retry");
      continue;
    }
    if (!member?.memberId || !member.cardId) {
      // Bez karty nie było z czego pobrać.
      await finishStep(doc._id, "spend", attempts, "failed");
      continue;
    }
    let found: FoundTransaction | null;
    try {
      found = await getLoyaltyClient().findTransactionByReason(
        member.memberId,
        member.cardId,
        `spend-${id}`,
        new Date(doc.createdAt.getTime() - 60_000),
      );
    } catch (err) {
      if (!(err instanceof LoyaltyUnavailableError)) throw err;
      await finishStep(doc._id, "spend", attempts, "retry");
      continue;
    }
    if (found?.status !== "APPROVED" || found.points >= 0) {
      await finishStep(doc._id, "spend", attempts, found && found.status !== "REJECTED" ? "retry" : "failed");
      continue;
    }

    const spent = -found.points;
    const pending = { _id: doc._id, "loyalty.spend.status": "pending", "loyalty.spend.attempts": attempts } as const;
    if (doc.status !== "paid") {
      await reservations.updateOne(pending, {
        $set: {
          pointsUsed: spent,
          cardAmount: doc.amount - spent,
          "loyalty.spend.status": "done",
          "loyalty.spend.points": spent,
          "loyalty.spend.at": new Date(),
        },
      });
      continue;
    }
    // Opłacona bez tych punktów: pobranie nie liczy się do biletu (failed), punkty wracają od razu.
    const claimed = await reservations.findOneAndUpdate(
      pending,
      {
        $set: {
          "loyalty.spend.status": "failed",
          "loyalty.spend.at": new Date(),
          "loyalty.refund": { status: "pending", points: spent, at: new Date(), attempts: 1 },
        },
      },
      { returnDocument: "after" },
    );
    if (claimed) await runStep(claimed, "refund", `refund-${id}`);
  }
}

/** Dzienny cron: niepewne pobrania, zaległe zwroty i naliczenia (najwyżej RETRY_BATCH każdego rodzaju). */
export async function runLoyaltyRetries(): Promise<{ refunded: number; earned: number }> {
  await resolveUncertainSpends(RETRY_BATCH);
  const refunded = await refundAll(await claimRefunds({}, RETRY_BATCH, true));

  let earned = 0;
  for (let i = 0; i < RETRY_BATCH; i++) {
    const doc = await claimEarn({}, true);
    if (!doc) break;
    if (await runStep(doc, "earn", `earn-${doc._id.toHexString()}`)) earned++;
  }
  return { refunded, earned };
}
