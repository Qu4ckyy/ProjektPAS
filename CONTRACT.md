# CONTRACT.md — Pociąg (PAS S01, Etap I)

Kontrakt wewnętrzny zespołu. Źródło prawdy dla wszystkich kart.
Zmiana tylko za zgodą lidera (Mateusz). Jeśli Twój agent uważa, że trzeba coś tu zmienić — zatrzymuje się i pisze, co i dlaczego.

---

## §1. Stack i środowisko

- Next.js 15 (App Router) + TypeScript (strict) + Tailwind + ESLint, katalog `src/`, alias `@/*`.
- MongoDB Atlas, oficjalny driver `mongodb` (v6). Bez Mongoose.
- Wdrożenie: Vercel (region `fra1`, klaster Atlas we Frankfurcie).
- Zmienne środowiskowe (`.env.local`, wzór w `.env.example`):

| Zmienna | Przykład | Opis |
|---|---|---|
| `MONGODB_URI` | `mongodb+srv://...` | connection string Atlas |
| `MONGODB_DB` | `pociag_mateusz` | nazwa bazy — **każdy ma swoją** (`pociag_mateusz`, `pociag_kamil`, `pociag_eryk`), testy: `pociag_test`, produkcja: `pociag` |
| `RESERVATION_TTL_SECONDS` | `900` | czas ważności rezerwacji; domyślnie 900, na testy CEO **120** |

- Next 15: `params` i `searchParams` są **Promise** (`const { id } = await params`). `useSearchParams()` w komponencie klienckim wymaga `<Suspense>`.
- Każdy route handler: `export const dynamic = "force-dynamic"`. Frontend pobiera dane z `cache: "no-store"`.

## §2. Model danych

### Kolekcja `events` (kurs pociągu)

```ts
type TrainEvent = {
  _id: string;          // "ic-1500-2026-12-04" — string, NIE ObjectId
  title: string;        // "IC 1500 Warszawa Centralna → Kraków Główny"
  startsAt: string;     // ISO 8601 UTC, "2026-12-04T07:15:00.000Z" (odjazd)
  seats: string[];      // ["1-1", ..., "1-20", "2-1", ..., "2-20"]
  // pola wariantu „pociąg”:
  trainNumber: string;  // "IC 1500"
  from: string;         // "Warszawa Centralna"
  to: string;           // "Kraków Główny"
  arrivesAt: string;    // ISO 8601 UTC (przyjazd)
  wagons: { number: number; seats: number }[]; // [{ number: 1, seats: 20 }, { number: 2, seats: 20 }]
};
```

- Przykładowe dane: 3 kursy, każdy 2 wagony × 20 miejsc. Stałe `_id`, daty w grudniu 2026.
- `startsAt`/`arrivesAt` są stringami (tak jak w przykładzie CEO). Porównując z „teraz”, używaj `new Date(event.startsAt)`.

### seatId

- Format `"<wagon>-<miejsce>"`, np. `"2-14"` = wagon 2, miejsce 14. Regex: `^[1-9]\d{0,2}-[1-9]\d{0,2}$`.
- Wagon: 5 rzędów × 4 miejsca, układ 2+2, korytarz pośrodku. Rząd `r` (1..5): `4r-3`, `4r-2` | korytarz | `4r-1`, `4r`.
- Okno: `n % 4 ∈ {0, 1}`; korytarz: `n % 4 ∈ {2, 3}`.
- Helpery w `src/lib/seats.ts`: `parseSeatId(seatId) → { wagon, seat } | null`, `isWindow(seat)`, `seatLabel(seatId) → "Wagon 2, miejsce 14"`.

### Kolekcja `reservations`

```ts
type Reservation = {
  _id: ObjectId;
  eventId: string;
  seatId: string;
  customerName: string;
  email: string;                 // NIGDY nie wraca w odpowiedziach API
  code: string | null;           // null do zakupu, potem "XXXX-XXXX"
  status: "held" | "purchased" | "expired";
  active: boolean;               // true = trzyma miejsce (held w trakcie albo purchased)
  createdAt: Date;
  expiresAt: Date;               // min(createdAt + RESERVATION_TTL_SECONDS, event.startsAt)
  purchasedAt?: Date;
};
```

- `expiresAt` nigdy nie wypada po odjeździe: `min(createdAt + TTL, new Date(event.startsAt))`. Rezerwacja zrobiona 5 minut przed odjazdem trzyma miejsce tylko 5 minut, więc zakup po odjeździe daje `410 RESERVATION_EXPIRED` (Z21). Bez nowego kodu błędu.

Indeksy (tworzy `ensureIndexes()` w `src/lib/db.ts`):
- UNIKALNY `{ eventId: 1, seatId: 1 }` z `partialFilterExpression: { active: true }` — **to jest ochrona przed podwójną rezerwacją**,
- UNIKALNY `{ code: 1 }` z `partialFilterExpression: { code: { $type: "string" } }`,
- `{ eventId: 1, active: 1 }`.

Zajęte miejsce (`takenSeats`) = rezerwacja `active: true` ORAZ (`status: "purchased"` LUB `expiresAt > now`).
Kupione miejsce **nigdy** nie wraca do puli.

### Kod biletu

- 8 znaków z alfabetu `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, format `XXXX-XXXX`, regex `^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$`.
- Generowany przez `crypto.randomBytes`. Kod nigdy nie wygląda jak ObjectId (ma myślnik), więc `/reservations/:param` rozróżnia oba.

## §3. API

Wszystkie odpowiedzi to JSON. Daty w odpowiedziach to ISO stringi.

| Metoda i ścieżka | Sukces | Błędy |
|---|---|---|
| `GET /api/events` | `200` `TrainEvent[]` posortowane po `startsAt` | `500` |
| `GET /api/events/:id` | `200` `{ event: TrainEvent, takenSeats: string[] }` | `404 EVENT_NOT_FOUND` |
| `POST /api/reservations` body `{ eventId, seatId, customerName, email }` | `201` `{ reservationId, expiresAt }` | `400 VALIDATION_ERROR`, `400 INVALID_SEAT`, `404 EVENT_NOT_FOUND`, `409 SEAT_TAKEN`, `409 EVENT_DEPARTED` |
| `POST /api/reservations/:id/purchase` (body ignorowane) | `200` `{ code }` (ponowny zakup → ten sam kod) | `404 RESERVATION_NOT_FOUND`, `410 RESERVATION_EXPIRED` |
| `GET /api/reservations/:id` | `200` `{ reservationId, eventId, seatId, customerName, status, expiresAt, serverNow, code?, event }` | `404 RESERVATION_NOT_FOUND` |
| `GET /api/tickets/:code` | `200` `{ code, seatId, customerName, purchasedAt, event }` | `404 TICKET_NOT_FOUND` |

Szczegóły:
- `POST /api/reservations`: `customerName` po `trim` 1–100 znaków, `email` po `trim` max 254 i rozsądny regex, `eventId` i `seatId` max 100 znaków. Każde pole **musi** być stringiem (`typeof === "string"`), inaczej 400 — to blokuje NoSQL injection (`{"$ne": null}`). Body > 10 kB → 400.
- `GET /api/reservations/:id`: `status` jest wyliczony (`held` z `expiresAt <= now` → `"expired"`). `code` tylko gdy `purchased`. `serverNow` pozwala frontendowi policzyć licznik niezależnie od zegara klienta. Bez e-maila.
- `POST /api/reservations`: zwrócone `expiresAt` może być krótsze niż TTL, jeśli pociąg odjeżdża wcześniej (§2).
- Zły `:id` (nie 24 znaki hex, `%7B%7D`, bardzo długi) → `404`, nigdy `500`. Używaj regexu `^[0-9a-f]{24}$` (tylko małe litery, bez flagi `i`), nie samego `ObjectId.isValid` (przepuszcza dowolne 12 znaków).
- Zepsute `%`-kodowanie w ścieżce (np. `/api/reservations/%E0%A4%A/purchase`) Next.js odrzuca przed handlerem: `400` jako strona HTML, nie JSON. Świadomie zostawiamy (to nie 500, a middleware to dodatkowe ryzyko).

## §4. Format błędów

Każdy błąd (4xx i 5xx):

```json
{ "error": "SEAT_TAKEN", "message": "To miejsce jest już zajęte." }
```

- `error` — stały kod z listy: `VALIDATION_ERROR`, `INVALID_SEAT`, `EVENT_NOT_FOUND`, `EVENT_DEPARTED`, `SEAT_TAKEN`, `RESERVATION_NOT_FOUND`, `RESERVATION_EXPIRED`, `TICKET_NOT_FOUND`, `INTERNAL_ERROR`.
- `message` — po polsku, dla człowieka. Frontend może go pokazać.
- Helper: `jsonError(status, error, message)` z `src/lib/errors.ts`.
- `500 INTERNAL_ERROR` nigdy nie zawiera stack trace ani treści wyjątku. Wyjątek logujemy na serwerze (`console.error`).

## §5. Strony i przepływ

| Strona | Co | Karta |
|---|---|---|
| `/` | rozkład jazdy: lista kursów | A (Kamil) |
| `/events/:id` | mapa wagonu z przełącznikiem wagonów | A (Kamil) |
| `/reserve?eventId=…&seatId=…` | formularz rezerwacji | B (Mateusz) |
| `/reservations/:param` | `param` = reservationId → licznik + „Kupuję bilet”; `param` = kod → bilet | B + C (Mateusz) |

Przepływ (dane przekazujemy **tylko przez URL**, bez localStorage):
1. `/events/:id` → klik w wolne miejsce → `/reserve?eventId=<id>&seatId=<seatId>` (`encodeURIComponent`).
2. `/reserve` → `POST /api/reservations` → `201` → `router.push("/reservations/<reservationId>")`.
3. `/reservations/<reservationId>` → `GET /api/reservations/:id` → licznik „Trzymamy Twoje miejsce jeszcze 14:32” + przycisk „Kupuję bilet”.
4. „Kupuję bilet” → `POST /api/reservations/:id/purchase` → `200 { code }` → `router.replace("/reservations/<code>")` → bilet (relacja, odjazd, wagon, miejsce, kod).
5. Po czasie (`410` albo `status: "expired"`) → „Rezerwacja wygasła, miejsce wróciło do puli” + link do mapy kursu.

## §6. Właściciele plików

Edytujesz tylko swoje pliki. Zmiana w cudzym pliku = wiadomość do lidera.
Wyjątek: po zmergowaniu karty drobne poprawki z przeglądu w jej plikach robi lider (Etap I: `SeatMap.tsx` w M2, `reservations.ts`, `validation.ts` i `tests/` w M3). Właściciel pliku się nie zmienia.

| Osoba | Pliki |
|---|---|
| **Mateusz** (lider) | `CONTRACT.md`, `package.json` i lockfile, configi (`next.config.ts`, `tsconfig.json`, `eslint`, `tailwind`), `.env.example`, `src/app/layout.tsx`, `src/app/globals.css`, `src/lib/types.ts`, `src/lib/errors.ts`, `src/lib/format.ts`, `src/components/brand/**`, `src/components/reservation/**`, `src/app/reserve/**`, `src/app/reservations/**`, `scripts/attack.mjs`, `scripts/reset.ts` |
| **Kamil** (karta A) | `src/data/events.ts`, `scripts/seed.ts`, `src/lib/events.ts`, `src/lib/seats.ts`, `src/app/page.tsx`, `src/app/events/**`, `src/app/api/events/**`, `src/components/events/**` |
| **Eryk** (karty B + C backend) | `src/lib/db.ts`, `src/lib/config.ts`, `src/lib/reservations.ts`, `src/lib/validation.ts`, `src/app/api/reservations/**`, `src/app/api/tickets/**`, `tests/**`, `vitest.config.ts` |

Funkcje współdzielone (sygnatur nie zmieniamy):
- `getTakenSeats(eventId: string): Promise<string[]>` — Eryk implementuje, Kamil wywołuje.
- `getEvent(id: string): Promise<TrainEvent | null>` — Kamil implementuje, Eryk wywołuje.
- `getDb(): Promise<Db>` — szkielet, Eryk dokłada `ensureIndexes()`.
- `parseSeatId`, `isWindow`, `seatLabel` — Kamil, używa też Mateusz.
- `formatDate`, `formatTime`, `formatDuration` (Europe/Warsaw, pl-PL) — Mateusz, używa też Kamil.

Git: branch na kartę, PR do `master`, review robi lider. Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`).
- `feature/skeleton` (Mateusz, wchodzi pierwszy),
- `feature/card-a-events` (Kamil),
- `feature/card-bc-reservations` (Eryk),
- `feature/card-bc-frontend` (Mateusz),
- `feature/attack` (Mateusz).

## §7. Lista zagrożeń

| # | Zagrożenie | Obrona | Kto |
|---|---|---|---|
| Z1 | Dwie osoby rezerwują to samo miejsce w tej samej chwili (50 równoległych żądań) | unikalny indeks częściowy `{eventId, seatId}` + `active: true`; E11000 → 409 | Eryk |
| Z2 | Wygasła rezerwacja blokuje miejsce na zawsze | `releaseExpired()` przed insertem; `getTakenSeats` filtruje `expiresAt > now` | Eryk |
| Z3 | Zakup po czasie | `findOneAndUpdate` z warunkiem `expiresAt > now` → 410 | Eryk |
| Z4 | Podwójny klik / równoległe zakupy | atomowy update; już kupiona → 200 z tym samym kodem | Eryk + Mateusz (blokada przycisku) |
| Z5 | Kupione miejsce wraca do puli | `purchased` zostaje `active: true`, nigdy nie wygasa | Eryk |
| Z6 | Śmieciowe dane: zły JSON, tablica, `null`, liczby, obiekty `{"$ne":null}`, ogromne stringi, brak pól | walidacja `typeof`, długości, regexy → 400 | Eryk |
| Z7 | Zły identyfikator w URL (`abc`, `%7B%7D`, 10 000 znaków) | regex przed zapytaniem → 404, nigdy 500 | Eryk + Kamil |
| Z8 | Kurs lub miejsce nie istnieje | 404 `EVENT_NOT_FOUND` / 400 `INVALID_SEAT` | Eryk |
| Z9 | Rezerwacja na kurs, który już odjechał | 409 `EVENT_DEPARTED` | Eryk |
| Z10 | Zgadywanie kodów biletów | `crypto.randomBytes`, 32^8 kombinacji, sprawdzanie formatu | Eryk |
| Z11 | Wyciek danych osobowych | e-mail nigdy w odpowiedzi; bilet po kodzie pokazuje tylko imię | Eryk |
| Z12 | Stack trace w odpowiedzi | `try/catch` → `500 INTERNAL_ERROR` z ogólnym komunikatem | wszyscy |
| Z13 | Mapa z cache pokazuje stare zajętości | `force-dynamic`, `no-store`, odświeżanie co 10 s i po `visibilitychange` | Kamil |
| Z14 | Ktoś zajął miejsce, zanim kliknąłem | formularz obsługuje 409 `SEAT_TAKEN`: komunikat + powrót do mapy | Mateusz |
| Z15 | Zegar klienta jest przestawiony | licznik liczony z `expiresAt` i `serverNow`, nie z `Date.now()` klienta | Mateusz |
| Z16 | XSS przez `customerName` | React escapuje; zakaz `dangerouslySetInnerHTML` | wszyscy |
| Z17 | Zła wartość `RESERVATION_TTL_SECONDS` | walidacja w `config.ts`, domyślnie 900 + warning | Eryk |
| Z18 | Burza połączeń do Mongo na Vercelu | jeden `MongoClient` trzymany w `globalThis` | Mateusz (szkielet) |
| Z19 | Atak CEO wyczerpie miejsca przed demem | `scripts/reset.ts` czyści rezerwacje przez `deleteMany({})` — nie `drop()`, bo to kasuje indeksy (Z1) | Mateusz |
| Z20 | Godziny w złej strefie | wyświetlanie w `Europe/Warsaw`, w bazie UTC | Kamil + Mateusz |
| Z21 | Zakup biletu po odjeździe pociągu (rezerwacja tuż przed odjazdem) | `expiresAt` przycięte do `startsAt` (§2) → zakup po odjeździe daje 410 | Mateusz (w pliku Eryka, M3) |
