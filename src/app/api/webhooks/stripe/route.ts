// POST /api/webhooks/stripe — CONTRACT.md §3, D8, Z27, Z28. Właściciel: Eryk. Bez limitu ruchu (D7).
import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { jsonError, withErrorHandling } from "@/lib/errors";
import { handleStripeEvent } from "@/lib/payments";
import { getStripe } from "@/lib/stripe";
import { readBodyBytes } from "@/lib/validation";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** Zdarzenia Stripe mają kilka kB; większego body nawet nie weryfikujemy. */
const MAX_WEBHOOK_BYTES = 1024 * 1024;

function invalidSignature() {
  return jsonError(400, "INVALID_SIGNATURE", "Nieprawidłowy podpis zdarzenia.");
}

export const POST = withErrorHandling("POST /api/webhooks/stripe", async (req: Request) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.error("[webhook] Brak STRIPE_WEBHOOK_SECRET — nie da się zweryfikować zdarzenia.");
    return invalidSignature();
  }
  const signature = req.headers.get("stripe-signature");
  if (!signature) return invalidSignature();

  // Surowe bajty — podpis Stripe liczy się z dokładnie tego body, nie z req.json().
  const body = await readBodyBytes(req, MAX_WEBHOOK_BYTES);
  if (!body.ok) return invalidSignature();

  // Poza try: brak klucza to nasz błąd, nie zły podpis → 500, a Stripe ponowi po naprawie konfiguracji.
  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body.value, signature, secret);
  } catch {
    return invalidSignature();
  }

  await handleStripeEvent(event);
  return NextResponse.json({ received: true }, { headers: NO_STORE });
});
