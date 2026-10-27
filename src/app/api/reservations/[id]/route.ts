// STUB — implementuje Eryk (CONTRACT.md §3: GET /api/reservations/:id).
import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "@/lib/errors";
import { getReservation } from "@/lib/reservations";
import { RESERVATION_ID_REGEX } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandling("GET /api/reservations/:id", async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const reservation = RESERVATION_ID_REGEX.test(id) ? await getReservation(id) : null;
  if (!reservation) return jsonError(404, "RESERVATION_NOT_FOUND", "Nie znaleziono rezerwacji.");
  return NextResponse.json(reservation);
});
