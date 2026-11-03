# CONTRACT.md — Pociąg „Konduktor” (PAS S01, Etap II)

Kontrakt wewnętrzny zespołu. Źródło prawdy dla wszystkich kart.
Zmiana tylko za zgodą lidera (Mateusz). Jeśli Twój agent uważa, że trzeba coś tu zmienić — zatrzymuje się i pisze, co i dlaczego.

**Etap II w jednym zdaniu:** klient płaci kartą przez Stripe Checkout (tryb testowy). Bilet z kodem dostaje dopiero po potwierdzeniu płatności przez webhook. Wszystko z Etapu I działa dalej, a kryteria Etapu I obowiązują do końca projektu.

Zmiany względem Etapu I są oznaczone **[E2]**.

---

## §0. Decyzje lidera (Etap II)

| # | Decyzja |
|---|---|
| D1 | Status `purchased` zmieniamy na **`paid`** (tak jak w PDF Etapu II), a `purchasedAt` na `paidAt`. Zmiana jest mechaniczna w całym repo i wchodzi w szkielecie (M1). |
| D2 | Strony powrotu ze Stripe: `/payment/success?reservationId=<id>` i `/payment/cancel?reservationId=<id>`. |
| D3 | Płatność zapisujemy w polu `payment` rezerwacji (§2). Zdarzenia Stripe logujemy w kolekcji `stripe_events`. |
| D4 | Ceny (grosze): IC 1500 → `8900`, EIP 5300 → `12900`, TLK 3820 → `5900`. |
| D5 | Stary `POST /api/reservations/:id/purchase` zostaje dla zgodności: opłacona → `200 { code }`, nieopłacona → `402 PAYMENT_REQUIRED`. Biletu bez płatności już się nie dostanie. |
| D6 | **Kryterium B1:** identyczny `POST /api/reservations` (ten sam kurs, miejsce, imię i e-mail) zwraca tę samą rezerwację (`200`), a nie `409`. |
| D7 | **Kryterium B5:** limit 40 żądań / 10 s / IP na `POST /api/reservations` i `POST /api/reservations/:id/checkout` → `429 RATE_LIMITED` z nagłówkiem `Retry-After`. Webhook nie ma limitu. |
| D8 | Płatność przyjmujemy tylko wtedy, gdy Stripe potwierdził ją najpóźniej 10 s po `expiresAt` i rezerwacja nadal trzyma miejsce. W każdym innym przypadku (spóźniona, druga za tę samą rezerwację, zła kwota) **automatyczny zwrot** i brak biletu. |
| D9 | Jedna sesja Stripe na rezerwację: klucz idempotencji `checkout-<reservationId>`. Ponowne „Zapłać” (po kolei albo równolegle) daje ten sam `url`. |
| D10 | Adresy powrotu budujemy z `APP_URL` (env), nigdy z nagłówka `Host`. |
| D11 | Serwer przyjmuje tylko klucz `sk_test_…`. Klucz `sk_live_…` → płatności wyłączone (`503`). |

## §1. Stack i środowisko

- Next.js 15 (App Router) + TypeScript (strict) + Tailwind + ESLint, katalog `src/`, alias `@/*`.
- MongoDB Atlas, oficjalny driver `mongodb` (v6). Bez Mongoose.
- **[E2]** Stripe: oficjalna paczka `stripe` (Node), wyłącznie tryb testowy. Lokalnie webhooki przekierowuje Stripe CLI: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`.
- Wdrożenie: Vercel (region `fra1`, klaster Atlas we Frankfurcie).
- Zmienne środowiskowe (`.env.local`, wzór w `.env.example`). **Klucze tylko na serwerze: nigdy w repo, nigdy z prefiksem `NEXT_PUBLIC_`, nigdy w odpowiedzi API.**

| Zmienna | Przykład | Opis |
|---|---|---|
| `MONGODB_URI` | `mongodb+srv://...` | connection string Atlas |
| `MONGODB_DB` | `pociag_mateusz` | nazwa bazy — każdy ma swoją, testy: `pociag_test`, produkcja: `pociag` |
| `RESERVATION_TTL_SECONDS` | `900` | czas ważności rezerwacji; domyślnie 900, na testy CEO **120** |
| **[E2]** `STRIPE_SECRET_KEY` | `sk_test_...` | klucz testowy Stripe (Dashboard → Developers → API keys) |
| **[E2]** `STRIPE_WEBHOOK_SECRET` | `whsec_...` | lokalnie z `stripe listen`, na Vercelu z endpointu w panelu Stripe |
| **[E2]** `APP_URL` | `http://localhost:3000` | adres aplikacji bez `/` na końcu; z niego budujemy `success_url` i `cancel_url` |
| **[E2]** `RATE_LIMIT_MAX` | `40` | ile żądań w oknie na IP (domyślnie 40) |
| **[E2]** `RATE_LIMIT_WINDOW_SECONDS` | `10` | długość okna (domyślnie 10) |

- Next 15: `params` i `searchParams` są **Promise** (`const { id } = await params`). `useSearchParams()` w komponencie klienckim wymaga `<Suspense>`.
- Każdy route handler: `export const dynamic = "force-dynamic"`. Frontend pobiera dane z `cache: "no-store"`.

## §2. Model danych

### Kolekcja `events` (kurs pociągu)

```ts
type TrainEvent = {
  _id: string;          // "ic-1500-2026-12-04" — string, NIE ObjectId
  title: string;        // "IC 1500 Warszawa Centralna → Kraków Główny"
  startsAt: string;     // ISO 8601 UTC (odjazd)
  seats: string[];      // ["1-1", ..., "2-20"]
  price: number;        // [E2] cena miejsca w groszach, liczba całkowita > 0, np. 8900 = 89,00 zł
  trainNumber: string;  // "IC 1500"
  from: string;
  to: string;
  arrivesAt: string;    // ISO 8601 UTC (przyjazd)
  wagons: { number: number; seats: number }[];
};
```

- 3 kursy, każdy 2 wagony × 20 miejsc, stałe `_id`, daty w grudniu 2026, ceny z D4. Waluta zawsze PLN.

### seatId

- Format `"<wagon>-<miejsce>"`, np. `"2-14"`. Regex: `^[1-9]\d{0,2}-[1-9]\d{0,2}$`.
- Układ 2+2, okno: `n % 4 ∈ {0, 1}`. Helpery w `src/lib/seats.ts`: `parseSeatId`, `isWindow`, `seatLabel`.

### Kolekcja `reservations`

```ts
type Reservation = {
  _id: ObjectId;
  eventId: string;
  seatId: string;
  customerName: string;
  email: string;                 // NIGDY nie wraca w odpowiedziach API
  amount: number;                // [E2] cena w groszach zapisana w chwili rezerwacji; potem się nie zmienia
  code: string | null;           // null do opłacenia, potem "XXXX-XXXX"
  status: "held" | "paid" | "expired";   // [E2] "purchased" → "paid"
  active: boolean;               // true = trzyma miejsce (held w trakcie albo paid)
  createdAt: Date;
  expiresAt: Date;               // min(createdAt + TTL, event.startsAt)
  paidAt?: Date;                 // [E2] zamiast purchasedAt
  payment?: {                    // [E2] tylko po pierwszym „Zapłać”
    sessionId: string;           // Stripe Checkout Session id, "cs_test_..."
    url: string;                 // adres strony płatności (ten sam przy ponownym „Zapłać”)
    createdAt: Date;
    paymentIntentId?: string;    // po potwierdzeniu płatności
    refunds?: { sessionId: string; refundId: string | null; reason: "late" | "duplicate" | "amount_mismatch" | "not_held"; at: Date }[];
  };
};
```

Indeksy (`ensureIndexes()` w `src/lib/db.ts`):
- UNIKALNY `{ eventId: 1, seatId: 1 }` z `partialFilterExpression: { active: true }` — ochrona przed podwójną rezerwacją,
- UNIKALNY `{ code: 1 }` z `partialFilterExpression: { code: { $type: "string" } }`,
- `{ eventId: 1, active: 1 }`,
- **[E2]** `{ "payment.sessionId": 1 }`.

Zajęte miejsce (`takenSeats`) = `active: true` ORAZ (`status: "paid"` LUB `expiresAt > now`). Opłacone miejsce **nigdy** nie wraca do puli.

### [E2] Kolekcja `stripe_events`

`{ _id: <event.id "evt_...">, type, reservationId?, outcome: "paid" | "refunded" | "ignored", receivedAt }`. Log i ochrona przed podwójnym przetworzeniem tego samego zdarzenia (Stripe ponawia webhooki).

### [E2] Kolekcja `rate_limits`

`{ _id: "<bucket>:<ip>:<numer okna>", count, expiresAt }` + indeks TTL na `expiresAt`. Tworzy ją `src/lib/rateLimit.ts`.

### Kod biletu

- 8 znaków z alfabetu `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, format `XXXX-XXXX`, z `crypto.randomBytes`. **[E2]** Generowany w chwili potwierdzenia płatności.

## §3. API

Wszystkie odpowiedzi to JSON. Daty to ISO stringi, kwoty to grosze (liczby całkowite). 2xx = sukces, 4xx = odmowa z komunikatem, 5xx = błąd serwera.

| Metoda i ścieżka | Sukces | Błędy |
|---|---|---|
| `GET /api/events` | `200` `TrainEvent[]` (z `price`) posortowane po `startsAt` | `500` |
| `GET /api/events/:id` | `200` `{ event, takenSeats }` (`event.price`) | `404 EVENT_NOT_FOUND` |
| `POST /api/reservations` body `{ eventId, seatId, customerName, email }` | `201` `{ reservationId, expiresAt, amount }`; **[E2]** powtórzone identyczne → `200` z tą samą rezerwacją | `400 VALIDATION_ERROR`, `400 INVALID_SEAT`, `404 EVENT_NOT_FOUND`, `409 SEAT_TAKEN`, `409 EVENT_DEPARTED`, **[E2]** `429 RATE_LIMITED` |
| **[E2]** `POST /api/reservations/:id/checkout` (body ignorowane) | `200` `{ url }` — strona płatności Stripe (ponownie: ten sam `url`) | `404 RESERVATION_NOT_FOUND`, `410 RESERVATION_EXPIRED`, `409 ALREADY_PAID`, `429 RATE_LIMITED`, `503 PAYMENT_UNAVAILABLE` |
| **[E2]** `POST /api/webhooks/stripe` (surowe body + nagłówek `Stripe-Signature`) | `200` `{ received: true }` | `400 INVALID_SIGNATURE`; `500` przy błędzie po naszej stronie (Stripe ponowi) |
| `GET /api/reservations/:id` | `200` `{ reservationId, eventId, seatId, customerName, status, amount, expiresAt, serverNow, code?, event }` | `404 RESERVATION_NOT_FOUND` |
| `GET /api/tickets/:code` | `200` `{ code, seatId, customerName, amount, paidAt, event }` — tylko opłacone | `404 TICKET_NOT_FOUND` |
| `POST /api/reservations/:id/purchase` (zgodność z Etapem I, D5) | `200` `{ code }` gdy `paid` | `402 PAYMENT_REQUIRED` gdy `held`, `410 RESERVATION_EXPIRED`, `404 RESERVATION_NOT_FOUND` |

Szczegóły:
- **Walidacja rezerwacji (bez zmian):** pola muszą być stringami (`typeof`), `customerName` 1–100 znaków bez znaków sterujących, `email` max 254 i regex, `eventId`/`seatId` max 100, body > 10 kB → 400.
- **[E2] Idempotencja rezerwacji (D6):** gdy miejsce trzyma aktywna rezerwacja z tym samym `eventId`, `seatId`, `customerName` (po trim) i `email` (po trim, bez wielkości liter) → `200 { reservationId, expiresAt, amount }` tej rezerwacji. Dotyczy wywołań po kolei i równoległych (przegrany insert z E11000 sprawdza, czyja jest blokująca rezerwacja). Inna osoba → `409 SEAT_TAKEN` jak dotąd.
- **[E2] `amount`** = `event.price` w chwili rezerwacji. Do Stripe idzie zawsze `amount` z bazy, nigdy kwota od klienta.
- **[E2] Checkout:**
  - kwota i opis z rezerwacji, `currency: "pln"`, `client_reference_id = reservationId`, `metadata.reservationId`, `customer_email`, `locale: "pl"`, idempotency key `checkout-<reservationId>`,
  - `success_url = APP_URL + "/payment/success?reservationId=<id>"`, `cancel_url = APP_URL + "/payment/cancel?reservationId=<id>"`,
  - jeśli rezerwacja ma już `payment.url`, wraca ten sam `url` bez wołania Stripe.
- **[E2] Webhook (D8):**
  - podpis weryfikujemy przez `stripe.webhooks.constructEvent(await req.text(), signature, STRIPE_WEBHOOK_SECRET)`; zły albo brak podpisu → `400`, nic się nie zmienia,
  - obsługujemy `checkout.session.completed` (gdy `payment_status === "paid"`) i `checkout.session.async_payment_succeeded`; inne typy → `200` i ignorujemy,
  - przyjęcie płatności to jedno atomowe `findOneAndUpdate({ _id, status: "held", active: true, expiresAt > event.created − 10 s })` → `paid` + `code` + `paidAt` + `payment.paymentIntentId`,
  - nie trafiło (rezerwacja wygasła i zwolniona, już opłacona inną sesją, zła kwota albo waluta) → `refunds.create({ payment_intent })` z idempotency key `refund-<sessionId>` i wpis w `payment.refunds`,
  - to samo zdarzenie drugi raz → `200` bez zmian (`stripe_events`).
- **[E2] `GET /api/reservations/:id`:** `status` wyliczony (`held` po `expiresAt` → `"expired"`). Gdy rezerwacja jest `held`, ma `payment.sessionId` i jeszcze nie wygasła, serwer pyta Stripe o sesję. Jeśli jest opłacona, przyjmuje płatność tą samą funkcją co webhook (strona powrotu nie czeka wtedy na spóźniony webhook). Odrzucenia i zwroty robi tylko webhook.
- **[E2] Limit ruchu (D7):** klucz to IP z `x-real-ip`, potem pierwszy adres z `x-forwarded-for`, a gdy brak obu: `"local"`. Okno stałe: `RATE_LIMIT_MAX` żądań na `RATE_LIMIT_WINDOW_SECONDS`. Po przekroczeniu `429` + `Retry-After: <sekundy do końca okna>`. Limit sprawdzamy **przed** walidacją, więc liczą się też złe żądania.
- Zły `:id` (nie `^[0-9a-f]{24}$`, `%7B%7D`, bardzo długi) → `404`, nigdy `500`. Zepsute `%`-kodowanie odrzuca Next.js (`400` HTML) — świadomie zostawiamy.

## §4. Format błędów

```json
{ "error": "SEAT_TAKEN", "message": "To miejsce jest już zajęte." }
```

- `error` — stały kod: `VALIDATION_ERROR`, `INVALID_SEAT`, `EVENT_NOT_FOUND`, `EVENT_DEPARTED`, `SEAT_TAKEN`, `RESERVATION_NOT_FOUND`, `RESERVATION_EXPIRED`, `TICKET_NOT_FOUND`, `INTERNAL_ERROR`, **[E2]** `ALREADY_PAID` (409), `PAYMENT_REQUIRED` (402), `RATE_LIMITED` (429), `INVALID_SIGNATURE` (400), `PAYMENT_UNAVAILABLE` (503).
- `message` — po polsku, dla człowieka. Helper: `jsonError(status, error, message)`, **[E2]** `rateLimited(retryAfterSeconds)` z `src/lib/errors.ts`.
- `5xx` nigdy nie zawiera stack trace, treści wyjątku ani komunikatu Stripe. Szczegóły tylko w `console.error`.

## §5. Strony i przepływ

| Strona | Co | Karta |
|---|---|---|
| `/` | rozkład jazdy, **[E2]** z ceną | A (Kamil) |
| `/events/:id` | mapa wagonu, **[E2]** z ceną miejsca | A (Kamil) |
| `/reserve?eventId=…&seatId=…` | formularz, **[E2]** z ceną | Mateusz |
| `/reservations/:param` | reservationId → licznik + **[E2]** „Zapłać 89,00 zł”; kod → bilet | Mateusz |
| **[E2]** `/payment/success?reservationId=…` | „Płatność w toku…” → sama zamienia się w bilet | C (Mateusz) |
| **[E2]** `/payment/cancel?reservationId=…` | „Płatność przerwana” + „Zapłać ponownie”, dopóki rezerwacja jest ważna | C (Mateusz) |

Przepływ (dane tylko przez URL, bez localStorage):
1. Mapa → `/reserve` → `POST /api/reservations` → `/reservations/<reservationId>` (licznik, cena).
2. „Zapłać 89,00 zł” → `POST /api/reservations/:id/checkout` → `window.location.assign(url)` → strona Stripe.
3. Zapłacone → Stripe wraca na `/payment/success?reservationId=…` → strona odpytuje `GET /api/reservations/:id` co 2 s (do 60 s) → `paid` → `router.replace("/reservations/<code>")` → bilet.
4. Przerwane („Wróć” na stronie Stripe) → `/payment/cancel?reservationId=…` → licznik + „Zapłać ponownie” (ten sam `url`); po czasie „Rezerwacja wygasła, miejsce wróciło do puli”.
5. **Bilet nigdy nie wynika z samego adresu powrotu** — tylko z `status: "paid"` w bazie.

## §6. Właściciele plików

Edytujesz tylko swoje pliki. Zmiana w cudzym pliku = wiadomość do lidera. Wyjątek: lider robi szkielet (M1, w tym mechaniczną zmianę `purchased` → `paid` w całym repo) i drobne poprawki po przeglądzie. Właściciel pliku się nie zmienia.

| Osoba | Pliki |
|---|---|
| **Mateusz** (lider) | `CONTRACT.md`, `PROMPTY*.md`, `README.md`, `DEPLOY.md`, `DEMO.md`, `package.json` i lockfile, configi, `.env.example`, `src/app/layout.tsx`, `src/app/globals.css`, `src/app/not-found.tsx`, `src/lib/types.ts`, `src/lib/errors.ts`, `src/lib/format.ts`, `src/components/brand/**`, `src/components/reservation/**`, **[E2]** `src/components/payment/**`, `src/app/reserve/**`, `src/app/reservations/**`, **[E2]** `src/app/payment/**`, `scripts/attack.mjs`, `scripts/reset.ts` |
| **Kamil** (karta A: Checkout + limit ruchu) | `src/data/events.ts`, `scripts/seed.ts`, `src/lib/events.ts`, `src/lib/seats.ts`, `src/app/page.tsx`, `src/app/events/**`, `src/app/api/events/**`, `src/components/events/**`, **[E2]** `src/lib/stripe.ts`, `src/lib/checkout.ts`, `src/lib/rateLimit.ts`, `src/app/api/reservations/[id]/checkout/**` |
| **Eryk** (karta B: Webhook + karta C backend) | `src/lib/db.ts`, `src/lib/config.ts`, `src/lib/reservations.ts`, `src/lib/validation.ts`, `src/app/api/reservations/**` (bez `checkout`), `src/app/api/tickets/**`, **[E2]** `src/lib/payments.ts`, `src/app/api/webhooks/**`, `tests/**`, `vitest.config.mts` |

Funkcje współdzielone (sygnatur nie zmieniamy; szkielet daje zaślepki):
- `getTakenSeats(eventId)` — Eryk; woła Kamil.
- `getEvent(id)` — Kamil; woła Eryk.
- **[E2]** `getStripe(): Stripe` — Kamil (`src/lib/stripe.ts`); rzuca `PaymentUnavailableError`, gdy brak klucza albo klucz nie jest `sk_test_`. Woła Eryk.
- **[E2]** `rateLimit(req: Request, bucket: "reservations" | "checkout"): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }>` — Kamil; woła Eryk w `POST /api/reservations`.
- **[E2]** `getCheckoutCandidate(id): Promise<{ ok: true; reservation: Reservation; event: TrainEvent } | { ok: false; error: "RESERVATION_NOT_FOUND" | "RESERVATION_EXPIRED" | "ALREADY_PAID" }>` — Eryk (`reservations.ts`); woła Kamil.
- **[E2]** `saveCheckoutSession(id, { sessionId, url }): Promise<void>` — Eryk; zapisuje `payment` tylko gdy rezerwacja jest `held` i nie ma jeszcze sesji. Woła Kamil.
- **[E2]** `formatPrice(grosze): string` → `"89,00 zł"` — Mateusz (`format.ts`); używa Kamil.

Git: branch na kartę, PR do `master`, review robi lider. Conventional Commits.
- `feature/e2-skeleton` (Mateusz, wchodzi pierwszy),
- `feature/e2-checkout` (Kamil),
- `feature/e2-webhook` (Eryk),
- `feature/e2-payment-frontend` (Mateusz),
- `feature/e2-attack` (Mateusz).

## §7. Lista zagrożeń

Z1–Z21 z Etapu I obowiązują dalej (zakup = teraz płatność). Kryteria CEO w nawiasach.

| # | Zagrożenie | Obrona | Kto |
|---|---|---|---|
| Z1 | Wyścig o to samo miejsce (B2) | unikalny indeks częściowy → 1×2xx, reszta 409 | Eryk |
| Z2 | Wygasła rezerwacja blokuje miejsce (A2, B4) | `takenSeats` filtruje `expiresAt > now`, `releaseExpired()` przed insertem | Eryk |
| Z3 | Zakup po czasie (C4) | checkout po czasie → 410; płatność po czasie → zwrot (Z24) | Kamil + Eryk |
| Z4 | Podwójny klik „Zapłać” (C1) | jedna sesja na rezerwację (D9) + blokada przycisku | Kamil + Mateusz |
| Z5 | Opłacone miejsce wraca do puli (C4) | `paid` zostaje `active: true` na zawsze | Eryk |
| Z6–Z8 | Śmieci, złe id, nieistniejący kurs lub miejsce (A1, B3, C3) | walidacja → 400/404, nigdy 500 | Eryk + Kamil |
| Z9, Z21 | Kurs odjechał / rezerwacja po odjeździe | 409; `expiresAt ≤ startsAt` | Eryk |
| Z10–Z12 | Zgadywanie kodów, wyciek e-maila, stack trace | `randomBytes`, brak e-maila w API, ogólne 500 | wszyscy |
| Z13–Z20 | Cache, „ktoś był szybszy”, zegar klienta, XSS, zły TTL, połączenia Mongo, reset, strefa czasu | jak w Etapie I | jak w Etapie I |
| **Z22** | Identyczna rezerwacja wysłana 2× (B1) | ta sama rezerwacja → `200` (D6) | Eryk |
| **Z23** | Jeden klient zalewa API (B5) | 40 / 10 s / IP → `429` + `Retry-After`; inne IP bez zmian; liczniki w Mongo (działa na wielu instancjach Vercela) | Kamil (+ Eryk woła) |
| **Z24** | Płatność po wygaśnięciu (strona Stripe otwarta dłużej niż rezerwacja) | webhook: brak biletu, automatyczny zwrot (D8) | Eryk |
| **Z25** | Płatność X w chwili wygaśnięcia vs rezerwacja Y (C2) | atomowe przejście `held → paid` tylko gdy `active`; przegrany dostaje zwrot; zawsze jeden właściciel | Eryk |
| **Z26** | Dwie płatności za tę samą rezerwację | jedna sesja (D9); gdyby jednak przyszła druga → zwrot `duplicate` | Kamil + Eryk |
| **Z27** | Sfałszowany webhook („zapłacone”) | weryfikacja podpisu na surowym body → 400, nic się nie zmienia | Eryk |
| **Z28** | Stripe ponawia ten sam webhook | `stripe_events` + atomowe przejścia → drugi raz bez zmian | Eryk |
| **Z29** | Kwota z klienta albo zmiana ceny po rezerwacji | kwota tylko z `amount` w bazie; webhook sprawdza `amount_total` i `currency` | Kamil + Eryk |
| **Z30** | Fałszywy powrót: ktoś wchodzi na `/payment/success` bez płacenia | bilet tylko przy `status: "paid"` w bazie, nigdy z URL | Mateusz + Eryk |
| **Z31** | Webhook spóźniony albo nie dotarł | strona powrotu odpytuje, a GET synchronizuje sesję ze Stripe | Eryk + Mateusz |
| **Z32** | Klucze Stripe w repo, w przeglądarce albo `sk_live_` | tylko env serwera, `.gitignore`, bez `NEXT_PUBLIC_`; serwer odrzuca `sk_live_` (D11) | wszyscy (Kamil: `stripe.ts`) |
| **Z33** | Przekierowanie na obcą domenę po płatności (nagłówek Host) | `success_url`/`cancel_url` z `APP_URL` (D10) | Kamil |
| **Z34** | Stripe niedostępny albo zwraca błąd | `503 PAYMENT_UNAVAILABLE`, rezerwacja nietknięta, „Zapłać” można ponowić; webhook przy błędzie bazy → 500, Stripe ponowi | Kamil + Eryk |
| **Z35** | Karta odrzucona albo 3D Secure | obsługuje strona Stripe; klient zostaje na niej albo wraca na `/payment/cancel` i płaci ponownie | Mateusz (test w M3) |
