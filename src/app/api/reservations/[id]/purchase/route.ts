// POST /api/reservations/:id/purchase — zgodność z Etapem I (CONTRACT.md §3, D5). Właściciel: Eryk.
// Po Etapie II bilet wydaje tylko płatność; ten endpoint oddaje kod opłaconej rezerwacji, a dla
// nieopłaconej odpowiada 402. Body jest ignorowane.
import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "@/lib/errors";
import { getLegacyPurchase, RESERVATION_ERRORS } from "@/lib/reservations";
import type { PurchaseResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

type Ctx = { params: Promise<{ id: string }> };

export const POST = withErrorHandling(
  "POST /api/reservations/:id/purchase",
  async (_req: Request, { params }: Ctx) => {
    const { id } = await params;
    const result = await getLegacyPurchase(id);
    if (!result.ok) {
      const { status, message } = RESERVATION_ERRORS[result.error];
      return jsonError(status, result.error, message);
    }
    const res: PurchaseResponse = { code: result.code };
    return NextResponse.json(res, { headers: NO_STORE });
  },
);
