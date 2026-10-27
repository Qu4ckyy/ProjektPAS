// STUB — implementuje Eryk (CONTRACT.md §3: POST /api/reservations/:id/purchase).
import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "@/lib/errors";
import { purchaseReservation } from "@/lib/reservations";
import { RESERVATION_ID_REGEX, type PurchaseResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withErrorHandling(
  "POST /api/reservations/:id/purchase",
  async (_req: Request, { params }: Ctx) => {
    const { id } = await params;
    if (!RESERVATION_ID_REGEX.test(id)) {
      return jsonError(404, "RESERVATION_NOT_FOUND", "Nie znaleziono rezerwacji.");
    }
    const res: PurchaseResponse = await purchaseReservation(id);
    return NextResponse.json(res);
  },
);
