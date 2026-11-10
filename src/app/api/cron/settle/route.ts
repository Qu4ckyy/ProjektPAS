// GET /api/cron/settle — dzienne domknięcie zaległych zwrotów punktów, naliczeń i maili (CONTRACT.md §3 [E3], D17, Z54).
// Właściciel: Eryk. Vercel Cron wysyła Authorization: Bearer <CRON_SECRET>; bez limitu ruchu.
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "@/lib/errors";
import { runLoyaltyRetries } from "@/lib/loyalty";
import { retryTicketEmails } from "@/lib/mail";
import type { CronSettleResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Brak sekretu w env → zawsze 401; porównanie stałoczasowe. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const GET = withErrorHandling("GET /api/cron/settle", async (req: Request) => {
  if (!authorized(req)) return jsonError(401, "UNAUTHORIZED", "Brak dostępu.");
  const { refunded, earned } = await runLoyaltyRetries();
  const emails = await retryTicketEmails();
  const res: CronSettleResponse = { refunded, earned, emails };
  return NextResponse.json(res, { headers: { "Cache-Control": "no-store" } });
});
