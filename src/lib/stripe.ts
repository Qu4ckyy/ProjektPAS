// Klient Stripe (tylko tryb testowy) — CONTRACT.md §1, D11, Z32.
// STUB — implementuje Kamil: jeden klient na proces, klucz sk_test_ z env, timeouty.
import type Stripe from "stripe";

/** Płatności niedostępne: brak klucza, klucz inny niż sk_test_ albo Stripe nie odpowiada → 503. */
export class PaymentUnavailableError extends Error {
  constructor(message = "Płatności są chwilowo niedostępne.") {
    super(message);
    this.name = "PaymentUnavailableError";
  }
}

export function getStripe(): Stripe {
  throw new PaymentUnavailableError("Stripe nie jest jeszcze skonfigurowany (zaślepka szkieletu).");
}
