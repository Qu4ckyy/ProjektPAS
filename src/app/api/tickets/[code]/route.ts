// GET /api/tickets/:code — CONTRACT.md §3. Właściciel: Eryk. Tylko opłacone bilety, bez e-maila (Z11).
import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "@/lib/errors";
import { getTicketByCode, RESERVATION_ERRORS } from "@/lib/reservations";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

type Ctx = { params: Promise<{ code: string }> };

export const GET = withErrorHandling("GET /api/tickets/:code", async (_req: Request, { params }: Ctx) => {
  const { code } = await params;
  // Kod normalizowany (trim, wielkie litery) i sprawdzany formatem przed zapytaniem (Z7, Z10).
  const ticket = await getTicketByCode(code);
  if (!ticket) {
    const { status, message } = RESERVATION_ERRORS.TICKET_NOT_FOUND;
    return jsonError(status, "TICKET_NOT_FOUND", message);
  }
  return NextResponse.json(ticket, { headers: NO_STORE });
});
