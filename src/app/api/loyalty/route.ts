// GET /api/loyalty?email=… — saldo punktów klienta (karta A, CONTRACT.md §3 [E3], D13, D14, D20). Właściciel: Eryk.
// Odpowiedź tylko { email, points } (Z49).
import { NextResponse } from "next/server";
import { jsonError, rateLimited, withErrorHandling } from "@/lib/errors";
import { getPoints } from "@/lib/loyalty";
import { rateLimit } from "@/lib/rateLimit";
import type { LoyaltyResponse } from "@/lib/types";
import { validateEmail } from "@/lib/validation";
import { LoyaltyUnavailableError } from "@/lib/voucherify";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export const GET = withErrorHandling("GET /api/loyalty", async (req: Request) => {
  const limit = await rateLimit(req, "loyalty");
  if (!limit.ok) return rateLimited(limit.retryAfterSeconds);

  const email = validateEmail(new URL(req.url).searchParams.get("email"));
  if (!email.ok) return jsonError(400, "VALIDATION_ERROR", email.message);
  try {
    const res: LoyaltyResponse = { email: email.value, points: await getPoints(email.value) };
    return NextResponse.json(res, { headers: NO_STORE });
  } catch (err) {
    if (!(err instanceof LoyaltyUnavailableError)) throw err;
    console.error("[loyalty] Voucherify niedostępny:", err);
    return jsonError(503, "LOYALTY_UNAVAILABLE", "Punkty chwilowo nie działają. Możesz zapłacić bez punktów.");
  }
});
