// Czyści rezerwacje, log zdarzeń Stripe i liczniki limitu, wgrywa kursy od nowa — przed demem, po ataku (Z19).
// Użycie: npm run reset -- --yes          (baza z MONGODB_DB w .env.local)
//         npm run reset -- --yes --prod   (wymagane dla bazy produkcyjnej "pociag")
// deleteMany, NIE drop(): drop() kasuje też indeksy, w tym unikalny indeks chroniący przed
// podwójną rezerwacją (Z1), a działający serwer zakłada je tylko raz na połączenie. To samo dotyczy
// indeksu TTL w rate_limits (bez niego liczniki przestałyby same wygasać).
// Uwaga: płatność za sesję Stripe, której rezerwacja zniknęła z bazy, nie dostaje automatycznego zwrotu
// — nie resetuj, gdy ktoś jest w trakcie płatności (skrypt ostrzega).
// [E3] Salda punktów żyją w Voucherify i reset ich nie rusza; loyalty_members to tylko pamięć podręczna
// (mapa e-mail → karta, blokady, blokada po 429) — czyścimy ją. Punkty pobrane za nieopłacone rezerwacje,
// których zwrot jeszcze nie przeszedł, po resecie już nie wrócą (skrypt ostrzega).
import { config } from "dotenv";
import { sampleEvents } from "../src/data/events";
import {
  closeDb,
  ensureIndexes,
  getDb,
  LOYALTY_MEMBERS_COLLECTION,
  RESERVATIONS_COLLECTION,
  STRIPE_EVENTS_COLLECTION,
} from "../src/lib/db";
import { EVENTS_COLLECTION } from "../src/lib/events";
import { RATE_LIMITS_COLLECTION } from "../src/lib/rateLimit";
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

  // Sesje Stripe żyją 24 h: nieopłacona rezerwacja z sesją może jeszcze zostać opłacona.
  const openPayments = await db.collection(RESERVATIONS_COLLECTION).countDocuments({
    status: { $ne: "paid" },
    "payment.sessionId": { $exists: true },
    createdAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });
  if (openPayments > 0) {
    console.log(
      `UWAGA: ${openPayments} nieopłaconych rezerwacji z otwartą sesją Stripe (< 24 h). ` +
        "Jeśli ktoś je teraz opłaci, nie dostanie automatycznego zwrotu — zwróć ręcznie w panelu Stripe.",
    );
  }

  // [E3] Pobrane punkty bez zakończonego zwrotu — po usunięciu rezerwacji nikt ich nie odda (D17).
  const pendingPointRefunds = await db.collection(RESERVATIONS_COLLECTION).countDocuments({
    status: { $ne: "paid" },
    "loyalty.spend.status": "done",
    "loyalty.refund.status": { $ne: "done" },
  });
  if (pendingPointRefunds > 0) {
    console.log(
      `UWAGA: ${pendingPointRefunds} nieopłaconych rezerwacji z pobranymi punktami bez zwrotu. ` +
        "Po resecie punkty nie wrócą same — przed resetem wywołaj /api/cron/settle albo oddaj je w panelu Voucherify.",
    );
  }

  const { deletedCount } = await db.collection(RESERVATIONS_COLLECTION).deleteMany({});
  console.log(`Usunięte rezerwacje: ${deletedCount}`);
  const stripeEvents = await db.collection(STRIPE_EVENTS_COLLECTION).deleteMany({});
  console.log(`Usunięte zdarzenia Stripe (log): ${stripeEvents.deletedCount}`);
  const rateLimits = await db.collection(RATE_LIMITS_COLLECTION).deleteMany({});
  console.log(`Usunięte liczniki limitu ruchu: ${rateLimits.deletedCount}`);
  const members = await db.collection(LOYALTY_MEMBERS_COLLECTION).deleteMany({});
  console.log(`Usunięta pamięć podręczna punktów (loyalty_members): ${members.deletedCount} — salda w Voucherify bez zmian.`);

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
