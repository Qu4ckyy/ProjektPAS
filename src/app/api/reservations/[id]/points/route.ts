// GET /api/reservations/:id/points — podpowiedź do pola „Użyj punktów” (CONTRACT.md §3 [E3]). Właściciel: Kamil.
// E-mail z rezerwacji, nigdy z URL; odpowiedź go nie zawiera.
// STUB — dopracowuje Kamil (PROMPTY K3, punkt 6).
import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { getDb, RESERVATIONS_COLLECTION } from "@/lib/db";
import { jsonError, rateLimited, withErrorHandling } from "@/lib/errors";
import { getPoints } from "@/lib/loyalty";
import { maxPointsFor } from "@/lib/points";
import { rateLimit } from "@/lib/rateLimit";
import { RESERVATION_ERRORS } from "@/lib/reservations";
import type { Reservation, ReservationPointsResponse } from "@/lib/types";
import { isReservationId } from "@/lib/validation";
import { LoyaltyUnavailableError } from "@/lib/voucherify";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

type Ctx = { params: Promise<{ id: string }> };

function notFound() {
  const { status, message } = RESERVATION_ERRORS.RESERVATION_NOT_FOUND;
  return jsonError(status, "RESERVATION_NOT_FOUND", message);
}

export const GET = withErrorHandling("GET /api/reservations/:id/points", async (req: Request, { params }: Ctx) => {
  const limit = await rateLimit(req, "loyalty");
  if (!limit.ok) return rateLimited(limit.retryAfterSeconds);

  const { id } = await params;
  if (!isReservationId(id)) return notFound();
  const reservation = await (await getDb())
    .collection<Reservation>(RESERVATIONS_COLLECTION)
    .findOne({ _id: new ObjectId(id) }, { projection: { email: 1, amount: 1, pointsUsed: 1, payment: 1 } });
  if (!reservation) return notFound();

  const pointsUsed = reservation.pointsUsed ?? 0;
  const locked = Boolean(reservation.payment);
  try {
    const balance = await getPoints(reservation.email);
    const res: ReservationPointsResponse = {
      balance,
      maxPoints: locked ? pointsUsed : Math.min(balance, maxPointsFor(reservation.amount)),
      pointsUsed,
      locked,
    };
    return NextResponse.json(res, { headers: NO_STORE });
  } catch (err) {
    if (!(err instanceof LoyaltyUnavailableError)) throw err;
    console.error(`[points] Voucherify niedostępny dla ${id}:`, err);
    return jsonError(503, "LOYALTY_UNAVAILABLE", "Punkty chwilowo nie działają. Możesz zapłacić bez punktów.");
  }
});
