// Limit ruchu na IP — CONTRACT.md §3, D7, Z23 (kryterium B5).
// STUB — implementuje Kamil: liczniki w kolekcji rate_limits, okno stałe, Retry-After.

export type RateLimitBucket = "reservations" | "checkout";

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function rateLimit(req: Request, bucket: RateLimitBucket): Promise<RateLimitResult> {
  return { ok: true };
}
