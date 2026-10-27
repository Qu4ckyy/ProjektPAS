// GET /api/events — CONTRACT.md §3. Właściciel: Kamil.
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/errors";
import { getEvents } from "@/lib/events";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export const GET = withErrorHandling("GET /api/events", async () => {
  return NextResponse.json(await getEvents(), { headers: NO_STORE });
});
