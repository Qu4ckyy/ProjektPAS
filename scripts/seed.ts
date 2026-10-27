// Idempotentny seed kursów do kolekcji events. Nie rusza kolekcji reservations.
// Użycie: npm run seed (czyta .env.local)
import { config } from "dotenv";
import { sampleEvents } from "../src/data/events";
import { closeDb, getDb } from "../src/lib/db";
import { EVENTS_COLLECTION } from "../src/lib/events";
import type { TrainEvent } from "../src/lib/types";

config({ path: ".env.local", quiet: true });

async function main() {
  const db = await getDb();
  console.log(`Baza: ${db.databaseName}, kolekcja: ${EVENTS_COLLECTION}`);

  const events = db.collection<TrainEvent>(EVENTS_COLLECTION);
  for (const event of sampleEvents) {
    const result = await events.replaceOne({ _id: event._id }, event, { upsert: true });
    const action = result.upsertedCount ? "dodany" : result.modifiedCount ? "zaktualizowany" : "bez zmian";
    console.log(`  ${event._id}: ${action}`);
  }
  console.log(`Gotowe: ${sampleEvents.length} kursy.`);
}

main()
  .catch((err) => {
    console.error("Seed nie powiódł się:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeDb);
