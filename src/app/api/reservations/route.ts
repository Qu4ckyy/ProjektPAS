// POST /api/reservations — CONTRACT.md §3. Właściciel: Eryk.
import { NextResponse } from "next/server";
import { jsonError, rateLimited, withErrorHandling } from "@/lib/errors";
import { rateLimit } from "@/lib/rateLimit";
import { createReservation, RESERVATION_ERRORS } from "@/lib/reservations";
import type { CreateReservationResponse } from "@/lib/types";
import { readJsonBody, validateReservationBody } from "@/lib/validation";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export const POST = withErrorHandling("POST /api/reservations", async (req: Request) => {
  // Limit przed walidacją — liczą się też złe żądania (D7, Z23).
  const limit = await rateLimit(req, "reservations");
  if (!limit.ok) return rateLimited(limit.retryAfterSeconds);

  const body = await readJsonBody(req);
  if (!body.ok) return jsonError(400, "VALIDATION_ERROR", body.message);
  const input = validateReservationBody(body.value);
  if (!input.ok) return jsonError(400, "VALIDATION_ERROR", input.message);

  const result = await createReservation(input.value);
  if (!result.ok) {
    const { status, message } = RESERVATION_ERRORS[result.error];
    return jsonError(status, result.error, message);
  }
  const res: CreateReservationResponse = {
    reservationId: result.reservationId,
    expiresAt: result.expiresAt.toISOString(),
    amount: result.amount,
  };
  return NextResponse.json(res, { status: 201, headers: NO_STORE });
});
