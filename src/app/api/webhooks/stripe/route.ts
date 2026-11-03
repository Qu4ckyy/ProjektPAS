// POST /api/webhooks/stripe — CONTRACT.md §3, D8. Właściciel: Eryk.
// STUB — Eryk dokłada weryfikację podpisu (stripe.webhooks.constructEvent na surowym body) i handleStripeEvent.
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/errors";

export const dynamic = "force-dynamic";

export const POST = withErrorHandling("POST /api/webhooks/stripe", async (req: Request) => {
  // Surowe body — podpis Stripe liczy się z dokładnie tych bajtów (nie req.json()).
  await req.text();
  return NextResponse.json({ received: true });
});
