// GET /api/reservations/:id — CONTRACT.md §3. Właściciel: Eryk. Bez e-maila (Z11).
import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "@/lib/errors";
import { getReservation, RESERVATION_ERRORS } from "@/lib/reservations";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandling("GET /api/reservations/:id", async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  // Zły format id → null bez zapytania do bazy (Z7).
  const reservation = await getReservation(id);
  if (!reservation) {
    const { status, message } = RESERVATION_ERRORS.RESERVATION_NOT_FOUND;
    return jsonError(status, "RESERVATION_NOT_FOUND", message);
  }
  return NextResponse.json(reservation, { headers: NO_STORE });
});
