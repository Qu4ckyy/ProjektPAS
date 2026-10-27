// Ładowane przed każdym plikiem testów (vitest.config.ts → setupFiles).
import { config } from "dotenv";

// MONGODB_URI z .env.local (zmienna ustawiona w powłoce ma pierwszeństwo).
config({ path: ".env.local", quiet: true });

// Testy zawsze na osobnej bazie — CONTRACT.md §1. Czyszczą reservations, więc nigdy nie na Twojej ani produkcyjnej.
process.env.MONGODB_DB = "pociag_test";
