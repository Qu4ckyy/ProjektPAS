// Potwierdzanie płatności ze Stripe — CONTRACT.md §3 (webhook), D8, Z24–Z31, Z34. Właściciel: Eryk.
// Bilet powstaje tylko tutaj: acceptPayment to jedyna ścieżka held → paid.
import { randomBytes } from "node:crypto";
import { ObjectId, type Collection } from "mongodb";
import type Stripe from "stripe";
import { getDb, isDuplicateKeyError, RESERVATIONS_COLLECTION, STRIPE_EVENTS_COLLECTION } from "@/lib/db";
import { runAfterResponse } from "@/lib/after";
import { earnForPurchase, settleLoyalty } from "@/lib/loyalty";
import { sendTicketEmail } from "@/lib/mail";
import { pointsEarnedFor } from "@/lib/points";
import { getStripe } from "@/lib/stripe";
import type { RefundReason, Reservation } from "@/lib/types";
import { isReservationId } from "@/lib/validation";

export type StripeEventOutcome = "paid" | "refunded" | "ignored";

type StripeEventLog = {
  _id: string;
  type: string;
  reservationId?: string;
  outcome: StripeEventOutcome;
  receivedAt: Date;
};

/** Alfabet kodu: 32 znaki bez 0, 1, I, O (CONTRACT.md §2). */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Ile razy losujemy nowy kod przy kolizji unikalnego indeksu (32^8 kombinacji — praktycznie nigdy). */
const MAX_CODE_ATTEMPTS = 5;

/** Płatność potwierdzona najpóźniej 10 s po expiresAt jest jeszcze przyjmowana (D8). */
const PAYMENT_GRACE_MS = 10_000;

const CURRENCY = "pln";

/** Synchronizacja odpowiada na GET klienta, więc nie może czekać na Stripe tak długo jak webhook. */
const SYNC_REQUEST_OPTIONS = { timeout: 3_000, maxNetworkRetries: 0 };

/**
 * Kod biletu XXXX-XXXX z crypto.randomBytes (Z10). 256 % 32 == 0, więc byte & 31
 * daje równy rozkład — bez modulo bias.
 */
export function generateCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < bytes.length; i++) {
    if (i === 4) code += "-";
    code += CODE_ALPHABET[bytes[i] & 31];
  }
  return code;
}

async function reservationsCollection(): Promise<Collection<Reservation>> {
  return (await getDb()).collection<Reservation>(RESERVATIONS_COLLECTION);
}

/** reservationId sesji: client_reference_id w dobrym formacie i zgodny z metadata, jeśli jest. */
function reservationIdOf(session: Stripe.Checkout.Session): string | null {
  const id = session.client_reference_id;
  if (!isReservationId(id)) return null;
  const fromMetadata = session.metadata?.reservationId;
  return fromMetadata === undefined || fromMetadata === id ? id : null;
}

function paymentIntentIdOf(session: Stripe.Checkout.Session): string | null {
  const intent = session.payment_intent;
  return typeof intent === "string" ? intent : (intent?.id ?? null);
}

/**
 * Przyjęcie płatności: jedno atomowe held → paid (D8, Z25). Rezerwacja musi trzymać miejsce,
 * być ważna najpóźniej 10 s przed confirmedAt i mieć kwotę z sesji (Z29).
 * Zwraca kod biletu albo null, gdy warunki nie są spełnione. Nigdy nie robi zwrotów.
 */
export async function acceptPayment(session: Stripe.Checkout.Session, confirmedAt: number): Promise<string | null> {
  const reservationId = reservationIdOf(session);
  // Brak kwoty sprawdzamy jawnie: filtr amount: null trafiłby też w dokument bez pola amount.
  if (!reservationId || session.currency !== CURRENCY || typeof session.amount_total !== "number") return null;

  const paymentIntentId = paymentIntentIdOf(session);
  const reservations = await reservationsCollection();
  for (let attempt = 0; ; attempt++) {
    try {
      const paid = await reservations.findOneAndUpdate(
        {
          _id: new ObjectId(reservationId),
          status: "held",
          active: true,
          // [E3] Sesja jest na cardAmount (amount − pointsUsed); rezerwacje sprzed Etapu III — na amount.
          $or: [
            { cardAmount: session.amount_total },
            { cardAmount: { $exists: false }, amount: session.amount_total },
          ],
          expiresAt: { $gt: new Date(confirmedAt - PAYMENT_GRACE_MS) },
        },
        {
          $set: {
            status: "paid",
            code: generateCode(),
            paidAt: new Date(),
            // [E3] Punkty za zakup od kwoty zapłaconej kartą (D18) — naliczenie po odpowiedzi.
            pointsEarned: pointsEarnedFor(session.amount_total),
            // attempts 0 = jeszcze nikt nie zaczął; earnForPurchase zajmuje krok (Z41).
            "loyalty.earn": { status: "pending", points: pointsEarnedFor(session.amount_total), at: new Date(), attempts: 0 },
            // Sesja, która zapłaciła — po niej rozpoznajemy powtórkę i drugą płatność.
            "payment.sessionId": session.id,
            ...(paymentIntentId ? { "payment.paymentIntentId": paymentIntentId } : {}),
          },
        },
        { returnDocument: "after", projection: { code: 1 } },
      );
      if (paid?.code) {
        await runAfterResponse("payments:after", () =>
          Promise.allSettled([earnForPurchase(reservationId), sendTicketEmail(reservationId)]),
        );
      }
      return paid?.code ?? null;
    } catch (err) {
      // Kolizja kodu z unikalnym indeksem — losujemy nowy.
      if (!isDuplicateKeyError(err) || attempt === MAX_CODE_ATTEMPTS - 1) throw err;
    }
  }
}

function refundReason(
  doc: Pick<Reservation, "status" | "amount" | "cardAmount" | "expiresAt">,
  session: Stripe.Checkout.Session,
  confirmedAt: number,
): RefundReason {
  if (doc.status === "paid") return "duplicate";
  if (session.currency !== CURRENCY || session.amount_total !== (doc.cardAmount ?? doc.amount)) return "amount_mismatch";
  return doc.expiresAt.getTime() <= confirmedAt - PAYMENT_GRACE_MS ? "late" : "not_held";
}

/**
 * Zwrot za płatność, której nie przyjęliśmy (D8). Rezerwacji nie ruszamy — nie oddajemy miejsca,
 * którego nie ma, i nie zabieramy cudzego. Klucz idempotencji chroni przed drugim zwrotem przy
 * ponowieniach; błąd Stripe idzie wyżej → 500 → Stripe ponowi webhook.
 */
async function refundSession(
  reservations: Collection<Reservation>,
  _id: ObjectId,
  session: Stripe.Checkout.Session,
  reason: RefundReason,
): Promise<void> {
  const paymentIntentId = paymentIntentIdOf(session);
  let refundId: string | null = null;
  if (paymentIntentId) {
    try {
      const refund = await getStripe().refunds.create(
        { payment_intent: paymentIntentId },
        { idempotencyKey: `refund-${session.id}` },
      );
      refundId = refund.id;
    } catch (err) {
      // Już zwrócona (np. z panelu Stripe) — ponawianie niczego nie zmieni.
      if ((err as { code?: unknown }).code !== "charge_already_refunded") throw err;
    }
  } else {
    console.error(`[payments] Sesja ${session.id} bez payment_intent — nie ma czego zwrócić.`);
  }
  // Warunek na sessionId: równoległa powtórka zdarzenia nie doda drugiego wpisu.
  await reservations.updateOne(
    { _id, "payment.refunds.sessionId": { $ne: session.id } },
    { $push: { "payment.refunds": { sessionId: session.id, refundId, reason, at: new Date() } } },
  );
}

/** Opłacona sesja ze zdarzenia: bilet albo zwrot. Bezpieczne do powtarzania (Z28). */
async function settleSession(
  session: Stripe.Checkout.Session,
  confirmedAt: number,
): Promise<{ reservationId?: string; outcome: StripeEventOutcome }> {
  const reservationId = reservationIdOf(session) ?? undefined;
  if (!reservationId) {
    console.warn(`[payments] Sesja ${session.id} bez poprawnego reservationId — pomijam.`);
    return { outcome: "ignored" };
  }

  if (await acceptPayment(session, confirmedAt)) return { reservationId, outcome: "paid" };

  const _id = new ObjectId(reservationId);
  const reservations = await reservationsCollection();
  const doc = await reservations.findOne(
    { _id },
    { projection: { status: 1, amount: 1, cardAmount: 1, expiresAt: 1, payment: 1, loyalty: 1 } },
  );
  if (!doc) {
    console.warn(`[payments] Sesja ${session.id}: rezerwacja ${reservationId} nie istnieje — pomijam.`);
    return { reservationId, outcome: "ignored" };
  }
  // Inne zdarzenie tej samej sesji albo ponowienie po błędzie: stan już jest końcowy.
  if (doc.status === "paid" && doc.payment?.sessionId === session.id) return { reservationId, outcome: "paid" };
  if (doc.payment?.refunds?.some((refund) => refund.sessionId === session.id)) {
    return { reservationId, outcome: "refunded" };
  }

  await refundSession(reservations, _id, session, refundReason(doc, session, confirmedAt));
  // [E3] Spóźniona płatność rezerwacji z punktami: oddajemy też punkty (Z40).
  if (doc.status !== "paid" && doc.loyalty?.spend?.status === "done") await settleLoyalty({ reservationId });
  return { reservationId, outcome: "refunded" };
}

async function processEvent(event: Stripe.Event): Promise<{ reservationId?: string; outcome: StripeEventOutcome }> {
  const confirmedAt = event.created * 1000;
  switch (event.type) {
    case "checkout.session.completed":
      // Płatności odroczone kończą się osobnym zdarzeniem async_payment_succeeded.
      if (event.data.object.payment_status !== "paid") return { outcome: "ignored" };
      return settleSession(event.data.object, confirmedAt);
    case "checkout.session.async_payment_succeeded":
      return settleSession(event.data.object, confirmedAt);
    default:
      return { outcome: "ignored" };
  }
}

/**
 * Zdarzenie Stripe po weryfikacji podpisu. Najpierw przetwarzamy (idempotentnie), potem logujemy:
 * błąd w połowie → wyjątek → 500 → Stripe ponawia. To samo event.id drugi raz → bez przetwarzania (Z28).
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<StripeEventOutcome> {
  const log = (await getDb()).collection<StripeEventLog>(STRIPE_EVENTS_COLLECTION);
  const seen = await log.findOne({ _id: event.id }, { projection: { outcome: 1 } });
  if (seen) return seen.outcome;

  const { reservationId, outcome } = await processEvent(event);
  try {
    await log.insertOne({
      _id: event.id,
      type: event.type,
      ...(reservationId ? { reservationId } : {}),
      outcome,
      receivedAt: new Date(),
    });
  } catch (err) {
    // Równoległa kopia tego samego zdarzenia zdążyła pierwsza — wynik jest ten sam.
    if (!isDuplicateKeyError(err)) throw err;
  }
  return outcome;
}

/**
 * Dla GET /api/reservations/:id: gdy webhook się spóźnia, a sesja jest opłacona, przyjmuje płatność
 * tą samą funkcją co webhook (Z31). Nigdy nie robi zwrotów — to tylko webhook. Błąd Stripe nie psuje
 * odczytu: zwraca false, a GET oddaje stan z bazy. Zwraca true, gdy płatność została przyjęta.
 */
export async function syncCheckoutSession(reservationId: string, sessionId: string): Promise<boolean> {
  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId, {}, SYNC_REQUEST_OPTIONS);
    if (session.payment_status !== "paid" || reservationIdOf(session) !== reservationId) return false;
    return (await acceptPayment(session, Date.now())) !== null;
  } catch (err) {
    console.error(`[payments] Nie udało się sprawdzić sesji ${sessionId} w Stripe:`, err);
    return false;
  }
}
