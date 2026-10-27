// STUB — implementuje Kamil (CONTRACT.md §3: GET /api/events/:id).
import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "@/lib/errors";
import { getEvent } from "@/lib/events";
import { getTakenSeats } from "@/lib/reservations";
import type { EventDetailsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandling("GET /api/events/:id", async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const event = await getEvent(id);
  if (!event) return jsonError(404, "EVENT_NOT_FOUND", "Nie ma takiego kursu.");
  const body: EventDetailsResponse = { event, takenSeats: await getTakenSeats(event._id) };
  return NextResponse.json(body);
});
