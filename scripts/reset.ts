// Czyści rezerwacje i wgrywa kursy od nowa — przed demem, po ataku (Z19).
// Użycie: npm run reset -- --yes          (baza z MONGODB_DB w .env.local)
//         npm run reset -- --yes --prod   (wymagane dla bazy produkcyjnej "pociag")
// deleteMany, NIE drop(): drop() kasuje też indeksy, w tym unikalny indeks chroniący przed
// podwójną rezerwacją (Z1), a działający serwer zakłada je tylko raz na połączenie.
import { config } from "dotenv";
import { sampleEvents } from "../src/data/events";
import { closeDb, ensureIndexes, getDb, RESERVATIONS_COLLECTION } from "../src/lib/db";
import { EVENTS_COLLECTION } from "../src/lib/events";
import type { TrainEvent } from "../src/lib/types";

config({ path: ".env.local", quiet: true });

const PROD_DB = "pociag";

async function main() {
  const args = process.argv.slice(2);
  const db = await getDb();
  console.log(`Baza: ${db.databaseName}`);

  if (!args.includes("--yes")) {
    console.log("Nic nie usunięto. Dodaj --yes, żeby skasować wszystkie rezerwacje w tej bazie.");
    process.exitCode = 1;
    return;
  }
  if (db.databaseName === PROD_DB && !args.includes("--prod")) {
    console.log(`To baza produkcyjna "${PROD_DB}". Dodaj też --prod, jeśli naprawdę chcesz ją wyczyścić.`);
    process.exitCode = 1;
    return;
  }

  const { deletedCount } = await db.collection(RESERVATIONS_COLLECTION).deleteMany({});
  console.log(`Usunięte rezerwacje: ${deletedCount}`);

  await ensureIndexes(db);
  console.log("Indeksy rezerwacji: OK");

  const events = db.collection<TrainEvent>(EVENTS_COLLECTION);
  for (const event of sampleEvents) await events.replaceOne({ _id: event._id }, event, { upsert: true });
  console.log(`Kursy: ${sampleEvents.length} wgrane od nowa.`);
}

main()
  .catch((err) => {
    console.error("Reset nie powiódł się:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeDb);
