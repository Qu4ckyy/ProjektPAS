// Format błędów — CONTRACT.md §4.
import { NextResponse } from "next/server";
import type { ErrorCode } from "@/lib/types";

export function jsonError(status: number, error: ErrorCode, message: string) {
  return NextResponse.json({ error, message }, { status });
}

/** 429 z nagłówkiem Retry-After (CONTRACT.md §3, D7). */
export function rateLimited(retryAfterSeconds: number) {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  return NextResponse.json(
    { error: "RATE_LIMITED", message: `Za dużo żądań. Spróbuj ponownie za ${seconds} s.` },
    { status: 429, headers: { "Retry-After": String(seconds) } },
  );
}

export function internalError(err: unknown, context: string) {
  // Szczegóły tylko w logach serwera — nigdy w odpowiedzi (Z12).
  console.error(`[${context}]`, err);
  return jsonError(500, "INTERNAL_ERROR", "Wystąpił nieoczekiwany błąd. Spróbuj ponownie.");
}

/**
 * Owija handler w try/catch: każdy nieobsłużony wyjątek → 500 INTERNAL_ERROR.
 * Użycie: export const GET = withErrorHandling("GET /api/events", async () => { ... });
 */
export function withErrorHandling<Args extends unknown[]>(
  context: string,
  handler: (...args: Args) => Promise<Response>,
) {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      return internalError(err, context);
    }
  };
}
