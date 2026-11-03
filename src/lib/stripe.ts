// Klient Stripe (tylko tryb testowy) — CONTRACT.md §1, D11, Z32. Właściciel: Kamil.
// Jeden klient na proces; klucz czytany przy pierwszym użyciu (nie przy buildzie) i nigdy nie logowany.
import Stripe from "stripe";

/** Płatności niedostępne: brak klucza, klucz inny niż sk_test_ albo Stripe nie odpowiada → 503. */
export class PaymentUnavailableError extends Error {
  constructor(message = "Płatności są chwilowo niedostępne.") {
    super(message);
    this.name = "PaymentUnavailableError";
  }
}

/** Ponowienia przy błędach sieci / 5xx Stripe (z tym samym idempotency key) i limit czasu żądania. */
const MAX_NETWORK_RETRIES = 2;
const TIMEOUT_MS = 10_000;

type StripeCache = { client: Stripe | null; key: string | null };

const globalForStripe = globalThis as typeof globalThis & { __stripe?: StripeCache };
const cache: StripeCache = (globalForStripe.__stripe ??= { client: null, key: null });

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new PaymentUnavailableError("Brak STRIPE_SECRET_KEY.");
  // D11: tylko klucz testowy. sk_live_ (i każdy inny) → płatności wyłączone. Klucza nie wypisujemy.
  if (!key.startsWith("sk_test_")) {
    throw new PaymentUnavailableError("STRIPE_SECRET_KEY nie jest kluczem testowym (sk_test_) — płatności wyłączone.");
  }

  // Nowy klient tylko przy zmianie klucza (np. w testach); normalnie jeden na proces.
  if (!cache.client || cache.key !== key) {
    cache.client = new Stripe(key, { maxNetworkRetries: MAX_NETWORK_RETRIES, timeout: TIMEOUT_MS });
    cache.key = key;
  }
  return cache.client;
}
