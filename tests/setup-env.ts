// Ładowane przed każdym plikiem testów (vitest.config.ts → setupFiles).
import { config } from "dotenv";

// MONGODB_URI z .env.local (zmienna ustawiona w powłoce ma pierwszeństwo).
config({ path: ".env.local", quiet: true });

// Testy zawsze na osobnej bazie — CONTRACT.md §1. Czyszczą reservations, więc nigdy nie na Twojej ani produkcyjnej.
process.env.MONGODB_DB = "pociag_test";

// Żądania w testach idą bez nagłówka IP, więc liczą się jako jeden klient, a Z1 sam wysyła 50 naraz.
// Nadpisujemy też wartość z .env.local (wzór ma 40). Testy limitu ustawiają własny w beforeEach.
process.env.RATE_LIMIT_MAX = "100000";

// [E3] Żaden test nie woła prawdziwego Voucherify ani Resend (CONTRACT.md §6) — nadpisujemy .env.local.
process.env.LOYALTY_PROVIDER = "memory";
process.env.MAIL_PROVIDER = "log";
