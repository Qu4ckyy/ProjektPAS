// Połączenie z MongoDB — jeden klient na proces (Z18).
import { MongoClient, type Db } from "mongodb";

type MongoCache = {
  client: MongoClient | null;
  db: Promise<Db> | null;
  indexes: Promise<void> | null;
};

const globalForMongo = globalThis as typeof globalThis & { __mongo?: MongoCache };
const cache: MongoCache = (globalForMongo.__mongo ??= { client: null, db: null, indexes: null });

export async function getDb(): Promise<Db> {
  if (!cache.db) {
    cache.db = connect().catch((err) => {
      // Nie trzymaj nieudanego połączenia — następne żądanie spróbuje ponownie.
      cache.db = null;
      cache.client = null;
      throw err;
    });
  }
  return cache.db;
}

async function connect(): Promise<Db> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("Brak MONGODB_URI — skopiuj .env.example do .env.local i uzupełnij.");
  }
  const client = new MongoClient(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 5000 });
  await client.connect();
  cache.client = client;
  const db = client.db(process.env.MONGODB_DB || "pociag");
  await ensureIndexesOnce(db);
  return db;
}

function ensureIndexesOnce(db: Db): Promise<void> {
  cache.indexes ??= ensureIndexes(db).catch((err) => {
    cache.indexes = null;
    throw err;
  });
  return cache.indexes;
}

export const RESERVATIONS_COLLECTION = "reservations";

/**
 * Indeksy kolekcji reservations — CONTRACT.md §2. Idempotentne (createIndexes z tymi samymi
 * opcjami nic nie zmienia). Woła je getDb() raz na połączenie, przed pierwszym zapytaniem.
 * Uwaga: drop() kolekcji usuwa też indeksy — do czyszczenia używaj deleteMany({}).
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await db.collection(RESERVATIONS_COLLECTION).createIndexes([
    // Ochrona przed podwójną rezerwacją (Z1): jedno aktywne miejsce na kurs.
    {
      key: { eventId: 1, seatId: 1 },
      name: "uniq_active_seat",
      unique: true,
      partialFilterExpression: { active: true },
    },
    // Kody biletów unikalne; rezerwacje bez kodu (null) nie wchodzą do indeksu.
    {
      key: { code: 1 },
      name: "uniq_code",
      unique: true,
      partialFilterExpression: { code: { $type: "string" } },
    },
    // takenSeats i releaseExpired dla kursu.
    { key: { eventId: 1, active: 1 }, name: "event_active" },
  ]);
}

/** Do skryptów (seed, reset, testy) — zamyka połączenie, żeby proces mógł się zakończyć. */
export async function closeDb(): Promise<void> {
  await cache.client?.close();
  cache.client = null;
  cache.db = null;
  cache.indexes = null;
}
