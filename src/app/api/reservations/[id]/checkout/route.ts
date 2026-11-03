// POST /api/reservations/:id/checkout — CONTRACT.md §3. Właściciel: Kamil. Body jest ignorowane (Z29).
import { NextResponse } from "next/server";
import { createCheckout } from "@/lib/checkout";
import { jsonError, rateLimited, withErrorHandling } from "@/lib/errors";
import { rateLimit } from "@/lib/rateLimit";
import { RESERVATION_ERRORS } from "@/lib/reservations";
import type { CheckoutResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

type Ctx = { params: Promise<{ id: string }> };

export const POST = withErrorHandling(
  "POST /api/reservations/:id/checkout",
  async (req: Request, { params }: Ctx) => {
    const limit = await rateLimit(req, "checkout");
    if (!limit.ok) return rateLimited(limit.retryAfterSeconds);

    const { id } = await params;
    const result = await createCheckout(id);
    if (!result.ok) {
      if (result.error === "PAYMENT_UNAVAILABLE") {
        return jsonError(503, "PAYMENT_UNAVAILABLE", "Płatności są chwilowo niedostępne. Spróbuj za chwilę.");
      }
      const { status, message } = RESERVATION_ERRORS[result.error];
      return jsonError(status, result.error, message);
    }
    const res: CheckoutResponse = { url: result.url };
    return NextResponse.json(res, { headers: NO_STORE });
  },
);
