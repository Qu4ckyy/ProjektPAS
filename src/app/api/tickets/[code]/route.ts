// STUB — implementuje Eryk (CONTRACT.md §3: GET /api/tickets/:code).
import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "@/lib/errors";
import { getTicketByCode } from "@/lib/reservations";
import { TICKET_CODE_REGEX } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ code: string }> };

export const GET = withErrorHandling("GET /api/tickets/:code", async (_req: Request, { params }: Ctx) => {
  const code = (await params).code.trim().toUpperCase();
  const ticket = TICKET_CODE_REGEX.test(code) ? await getTicketByCode(code) : null;
  if (!ticket) return jsonError(404, "TICKET_NOT_FOUND", "Nie znaleziono biletu.");
  return NextResponse.json(ticket);
});
