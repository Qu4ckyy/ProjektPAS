// STUB — implementuje Kamil (CONTRACT.md §3: GET /api/events).
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/errors";
import { getEvents } from "@/lib/events";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling("GET /api/events", async () => {
  return NextResponse.json(await getEvents());
});
