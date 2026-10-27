// GET /api/events — CONTRACT.md §3. Właściciel: Kamil.
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/errors";
import { getEvents } from "@/lib/events";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling("GET /api/events", async () => {
  return NextResponse.json(await getEvents());
});
