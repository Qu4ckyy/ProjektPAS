// POST /api/reservations/:id/purchase — CONTRACT.md §3. Właściciel: Eryk. Body jest ignorowane.
import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "@/lib/errors";
import { purchaseReservation, RESERVATION_ERRORS } from "@/lib/reservations";
import type { PurchaseResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

type Ctx = { params: Promise<{ id: string }> };

export const POST = withErrorHandling(
  "POST /api/reservations/:id/purchase",
  async (_req: Request, { params }: Ctx) => {
    const { id } = await params;
    // Zły format id → RESERVATION_NOT_FOUND bez zapytania do bazy (Z7).
    const result = await purchaseReservation(id);
    if (!result.ok) {
      const { status, message } = RESERVATION_ERRORS[result.error];
      return jsonError(status, result.error, message);
    }
    const res: PurchaseResponse = { code: result.code };
    return NextResponse.json(res, { headers: NO_STORE });
  },
);
