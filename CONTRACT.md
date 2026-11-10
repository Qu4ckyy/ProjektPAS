# CONTRACT.md — Pociąg „Konduktor” (PAS S01, Etap III)

Kontrakt wewnętrzny zespołu. Źródło prawdy dla wszystkich kart.
Zmiana tylko za zgodą lidera (Mateusz). Jeśli Twój agent uważa, że trzeba coś tu zmienić — zatrzymuje się i pisze, co i dlaczego.

**Etap III w jednym zdaniu:** program lojalnościowy — klient zbiera punkty w Voucherify (1000 na start, 10 pkt za każdy pełny złoty zapłacony kartą), może nimi zapłacić do połowy ceny biletu (1 pkt = 1 grosz), a po zakupie dostaje mail z biletem przez Resend. Wszystko z Etapów I i II działa dalej, a kryteria obu etapów obowiązują do końca projektu.

Zmiany względem Etapu I są oznaczone **[E2]**, względem Etapu II — **[E3]**.

---

## §0a. [E3] Decyzje lidera (Etap III)

| # | Decyzja |
|---|---|
| D12 | **Źródłem prawdy o saldzie jest Voucherify** — Loyalty Hub (**API v2**): program `lprg_1353662608979a6d4e` „Konduktor punkty”, portfel `lcdef_135367367d579a1d98` „Punkty” (bez wygasania, ujemne saldo zablokowane, punkty aktywne od razu). PDF podaje endpoint v1 (`/v1/loyalties/members/{memberId}/balance`), ale nowe konta Voucherify mają już tylko Loyalty Hub v2, a modeli nie da się mieszać — jego odpowiednikiem jest `POST /v2/…/cards/{cardId}/points` (§3). U siebie trzymamy tylko: ile punktów użyła i zebrała rezerwacja (`pointsUsed`, `pointsEarned`, `loyalty` w §2) oraz mapę e-mail → karta w kolekcji `loyalty_members` (żeby nie szukać karty przy każdym wywołaniu — limit sandboxa to 100 wywołań na godzinę). |
| D13 | Klient = e-mail po `trim()` i `toLowerCase()`. To `source_id` klienta w Voucherify (`customer_source_id` w v2). `Jan@Example.com` i `jan@example.com` to ten sam klient. |
| D14 | **Karty nie zakładamy przy samym sprawdzeniu salda.** E-mail bez karty ma 1000 punktów, ale kartę (i 1000 punktów powitalnych na niej) tworzymy dopiero przy pierwszym wydaniu albo naliczeniu punktów. Punkty powitalne dodaje nasz kod, dokładnie raz na e-mail (§3, Z51). |
| D15 | **Punkty schodzą przy „Zapłać”**, przed utworzeniem sesji Stripe (karta B z PDF). Sesja Stripe jest na `cardAmount = amount − pointsUsed`. |
| D16 | **Punkty są zablokowane po pierwszym „Zapłać”.** Ponowne „Zapłać” z tą samą liczbą punktów albo bez `points` → ten sam `url` (D9 dalej obowiązuje). Inna liczba punktów → `409 POINTS_LOCKED`. Jedna sesja Stripe na rezerwację, klucz idempotencji bez zmian. |
| D17 | **Zwrot punktów:** punkty pobrane za rezerwację, która nie została opłacona (wygasła, płatność spóźniona i zwrócona), wracają na kartę. Zwrot robi `settleLoyalty` (§3) przy odczycie rezerwacji, przy odczycie salda tego e-maila, w webhooku przy spóźnionej płatności i raz dziennie przez Vercel Cron. Zwrot atomowo zamyka rezerwację (`expired`, `active: false`), więc spóźniona płatność już jej nie opłaci (dostanie zwrot pieniędzy, D8). |
| D18 | **Punkty za zakup:** `pointsEarned = floor(cardAmount / 100) × 10`, wyliczone przy przyjęciu płatności i zapisane w rezerwacji. Naliczenie w Voucherify idzie po odpowiedzi (`after()` z `next/server`); gdy Voucherify nie działa, zostaje do ponowienia — bilet i tak jest. |
| D19 | **Mail z biletem** wysyłamy raz na rezerwację po przyjęciu płatności (webhook albo synchronizacja w GET), przez Resend z nagłówkiem `Idempotency-Key: ticket-<reservationId>`. Błąd maila (Resend nie działa, `bounced@resend.dev`, adres spoza testowych) nigdy nie psuje biletu ani odpowiedzi API. |
| D20 | **Voucherify niedostępny albo limit 100/h:** checkout bez punktów działa jak w Etapie II i w ogóle nie woła Voucherify. Checkout z punktami → `503 LOYALTY_UNAVAILABLE`, rezerwacja nietknięta. `GET /api/loyalty` oddaje saldo z pamięci podręcznej (§2), a bez niej `503`. |
| D21 | Dostawcy przełączani zmienną: `LOYALTY_PROVIDER=voucherify\|memory`, `MAIL_PROVIDER=resend\|log`. `memory` (punkty w pamięci procesu) i `log` (mail tylko w `console.log`) są do testów i lokalnej pracy bez zjadania limitu. **Na Vercelu tylko `voucherify` i `resend`** — kod odmawia `memory`/`log`, gdy `VERCEL_ENV === "production"`. |
| D22 | Body checkoutu: liczy się tylko `points`. Każde inne pole (np. `{ "amount": 100 }`, kryterium II.A1) ignorujemy — kwota zawsze z bazy. |

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
- **[E3]** Voucherify: zwykły `fetch` do REST API (bez SDK) — Loyalty Hub **v2** (`/v2/loyalties/programs/…`) plus `/v1/customers` do założenia klienta; nagłówki `X-App-Id` i `X-App-Token`, projekt **Sandbox**, region Europe (`https://api.voucherify.io`). Każde wywołanie z timeoutem 5 s. **Zmiana punktów w v2 jest asynchroniczna:** odpowiedź to transakcja `lctx_…` w stanie `PENDING`, a o wyniku (`APPROVED` / `REJECTED`) mówi dopiero lista transakcji karty (§3, „Operacje na punktach”). Sandbox: **100 wywołań na godzinę** na cały projekt — liczymy je (§3, „Budżet wywołań”).
- **[E3]** Resend: zwykły `fetch` do `POST https://api.resend.com/emails` (bez SDK), `Authorization: Bearer re_…`, nadawca `onboarding@resend.dev`. Bez własnej domeny Resend dostarcza tylko na adres właściciela konta i adresy testowe (`delivered@resend.dev`, `bounced@resend.dev`, z dowolną etykietą po `+`); inny adres → `403` od Resend, czyli mail „failed” (D19).
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
| **[E3]** `LOYALTY_PROVIDER` | `voucherify` | `voucherify` albo `memory` (testy, lokalnie); na Vercelu tylko `voucherify` (D21) |
| **[E3]** `VOUCHERIFY_API_URL` | `https://api.voucherify.io` | adres klastra z Project settings → Application keys (bez `/` na końcu) |
| **[E3]** `VOUCHERIFY_APP_ID` | `…` | Application ID projektu Sandbox |
| **[E3]** `VOUCHERIFY_SECRET_KEY` | `…` | Secret Key projektu Sandbox (nagłówek `X-App-Token`) |
| **[E3]** `VOUCHERIFY_PROGRAM_ID` | `lprg_1353662608979a6d4e` | id programu w Loyalty Hub (to nie sekret) |
| **[E3]** `VOUCHERIFY_CARD_DEFINITION_ID` | `lcdef_135367367d579a1d98` | id portfela „Punkty” — z kart klienta bierzemy tę z tym portfelem |
| **[E3]** `MAIL_PROVIDER` | `resend` | `resend` albo `log` (testy, lokalnie); na Vercelu tylko `resend` (D21) |
| **[E3]** `RESEND_API_KEY` | `re_…` | klucz API Resend (uprawnienie „Sending access”) |
| **[E3]** `MAIL_FROM` | `Konduktor <onboarding@resend.dev>` | nadawca maili |
| **[E3]** `CRON_SECRET` | losowy ciąg ≥ 32 znaki | Vercel wysyła go jako `Authorization: Bearer …` do `/api/cron/settle` |

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
  pointsUsed?: number;           // [E3] ustalane przy pierwszym „Zapłać” (0, gdy bez punktów); potem się nie zmienia (D16)
  cardAmount?: number;           // [E3] amount − pointsUsed, ustalane razem z pointsUsed; na tę kwotę jest sesja Stripe
  pointsEarned?: number;         // [E3] floor(cardAmount / 100) × 10, ustalane przy przyjęciu płatności (D18)
  loyalty?: {                    // [E3] stan operacji w Voucherify — ochrona przed podwójnym wykonaniem
    spend?: LoyaltyStep;         // pobranie pointsUsed z karty (karta B, Kamil)
    refund?: LoyaltyStep;        // zwrot pointsUsed na kartę, gdy rezerwacja nie została opłacona (D17, Eryk)
    earn?: LoyaltyStep;          // naliczenie pointsEarned po opłaceniu (D18, Eryk)
  };
  ticketEmail?: {                // [E3] mail z biletem (D19, Mateusz)
    status: "sending" | "sent" | "retry" | "failed";
    attempts: number;
    resendId?: string;
    lastError?: string;          // krótki opis do logów/diagnozy, nigdy nie wraca w API
    at: Date;
  };
};

// [E3] Każda operacja w Voucherify przechodzi: (brak) → "pending" (zajęta atomowo, trwa wywołanie)
// → "done" | "retry" (błąd, do ponowienia) | "failed" (definitywnie nie wyszło, np. za mało punktów).
type LoyaltyStep = { status: "pending" | "done" | "retry" | "failed"; points: number; at: Date; attempts: number };
```

**[E3] Zasady pól lojalnościowych:**
- Brak `pointsUsed` w dokumencie (rezerwacje z Etapu II, rezerwacja przed „Zapłać”) = `0` w API.
- Operację w Voucherify wolno zacząć tylko po atomowym `findOneAndUpdate`, który przestawia jej krok z „brak/`retry`” na `pending`. Kto nie wygrał, nie woła Voucherify. Dzięki temu podwójny klik, powtórzony webhook i równoległy GET nie wykonują operacji dwa razy.
- Krok w `pending` dłużej niż 2 minuty uznajemy za przerwany (padła funkcja na Vercelu). Wtedy przed ponowieniem **sprawdzamy w Voucherify**, czy operacja już przeszła (§3, „Operacje na punktach”), i dopiero potem wołamy ją jeszcze raz.
- `spend` wolno zacząć tylko, dopóki rezerwacja nie ma `payment` (potem punkty są zablokowane, D16). `refund` dotyczy tylko rezerwacji, która ma `spend: done` i nie jest `paid`. `earn` dotyczy tylko `paid`.

Indeksy (`ensureIndexes()` w `src/lib/db.ts`):
- UNIKALNY `{ eventId: 1, seatId: 1 }` z `partialFilterExpression: { active: true }` — ochrona przed podwójną rezerwacją,
- UNIKALNY `{ code: 1 }` z `partialFilterExpression: { code: { $type: "string" } }`,
- `{ eventId: 1, active: 1 }`,
- **[E2]** `{ "payment.sessionId": 1 }`,
- **[E3]** `{ email: 1, "loyalty.spend.status": 1 }` — szukanie rezerwacji z punktami do zwrotu dla e-maila,
- **[E3]** `{ "loyalty.spend.status": 1, expiresAt: 1 }` — dzienny cron,
- **[E3]** `{ status: 1, "loyalty.earn.status": 1 }` — naliczenia do ponowienia.

### [E3] Kolekcja `loyalty_members`

```ts
type LoyaltyMember = {
  _id: string;                   // e-mail po trim + lowercase (D13)
  memberId: string | null;       // "lmbr_…" — członek programu w Voucherify; null = sprawdziliśmy, nie ma go
  cardId: string | null;         // "lcrd_…" — jego karta w portfelu VOUCHERIFY_CARD_DEFINITION_ID
  status: "creating" | "ready" | "absent";
  welcome?: "pending" | "done";  // 1000 punktów powitalnych — dokładnie raz (Z51)
  balance?: number;              // ostatnie znane saldo z Voucherify (pamięć podręczna, D20)
  balanceAt?: Date;
  spendLockUntil?: Date;         // blokada wydawania punktów tego e-maila (Z36)
  checkedAt: Date;
};
```

- Założenie karty: atomowe przejście `absent`/brak dokumentu → `creating` (wygrywa jeden), potem w Voucherify: klient (`POST /v1/customers` z `source_id` = e-mail — upsert), członek programu (`POST /v2/loyalties/programs/{programId}/members`); odpowiedź `409 member_already_exists` = członek już jest (np. założony w panelu marketingu) → odczyt członkostwa i **bez** punktów powitalnych. Nowy członek → +1000 (`reason: "welcome-<email>"`, czekamy na `APPROVED`). Na końcu `ready`.
- `balance` to tylko pamięć podręczna: odświeżana przy każdej naszej operacji (Voucherify zwraca nowe saldo) i najwyżej co 30 s przy odczycie. Do decyzji o wydaniu punktów **zawsze** świeży odczyt z Voucherify.
- `status: "absent"` sprawdzamy w Voucherify ponownie najwcześniej po 10 minutach.

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
| **[E2]** `POST /api/reservations/:id/checkout`, **[E3]** body opcjonalne `{ points }` | `200` `{ url, pointsUsed, cardAmount }` — strona płatności Stripe na `cardAmount` (ponownie: ten sam `url`) | `404 RESERVATION_NOT_FOUND`, `410 RESERVATION_EXPIRED`, `409 ALREADY_PAID`, `429 RATE_LIMITED`, `503 PAYMENT_UNAVAILABLE`, **[E3]** `400 VALIDATION_ERROR` (zły `points`), `400 POINTS_OVER_LIMIT`, `409 INSUFFICIENT_POINTS`, `409 POINTS_LOCKED`, `409 LOYALTY_BUSY`, `503 LOYALTY_UNAVAILABLE` |
| **[E3]** `GET /api/loyalty?email=…` | `200` `{ email, points }` — saldo (e-mail po normalizacji D13); e-mail bez karty → `points: 1000` | `400 VALIDATION_ERROR`, `429 RATE_LIMITED`, `503 LOYALTY_UNAVAILABLE` |
| **[E3]** `GET /api/reservations/:id/points` | `200` `{ balance, maxPoints, pointsUsed, locked }` — podpowiedź do pola „Użyj punktów” (e-mail z rezerwacji, nie z URL) | `404 RESERVATION_NOT_FOUND`, `429 RATE_LIMITED`, `503 LOYALTY_UNAVAILABLE` |
| **[E3]** `GET /api/cron/settle` (nagłówek `Authorization: Bearer <CRON_SECRET>`) | `200` `{ refunded, earned, emails }` — dzienne domknięcie zaległych zwrotów, naliczeń i maili | `401` bez poprawnego sekretu |
| **[E2]** `POST /api/webhooks/stripe` (surowe body + nagłówek `Stripe-Signature`) | `200` `{ received: true }` | `400 INVALID_SIGNATURE`; `500` przy błędzie po naszej stronie (Stripe ponowi) |
| `GET /api/reservations/:id` | `200` `{ reservationId, eventId, seatId, customerName, status, amount, expiresAt, serverNow, code?, event }`, **[E3]** + `pointsUsed` (liczba, 0 bez punktów), `cardAmount` (`amount − pointsUsed`), `pointsEarned` (liczba po opłaceniu, wcześniej `null`) | `404 RESERVATION_NOT_FOUND` |
| `GET /api/tickets/:code` | `200` `{ code, seatId, customerName, amount, paidAt, event }`, **[E3]** + `pointsUsed`, `cardAmount`, `pointsEarned` — tylko opłacone | `404 TICKET_NOT_FOUND` |
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
  - **[E3]** kwota w warunku to `cardAmount` (gdy brak — `amount`); to samo przejście zapisuje `pointsEarned = pointsEarnedFor(cardAmount)` i `loyalty.earn: { status: "pending" }`, a po odpowiedzi rusza naliczenie punktów i mail (§6),
  - **[E3]** zwrot pieniędzy za płatność rezerwacji z `spend: done`, która nie jest `paid`, woła też `settleLoyalty` (zwrot punktów, Z40),
  - nie trafiło (rezerwacja wygasła i zwolniona, już opłacona inną sesją, zła kwota albo waluta) → `refunds.create({ payment_intent })` z idempotency key `refund-<sessionId>` i wpis w `payment.refunds`,
  - to samo zdarzenie drugi raz → `200` bez zmian (`stripe_events`).
- **[E2] `GET /api/reservations/:id`:** `status` wyliczony (`held` po `expiresAt` → `"expired"`). Gdy rezerwacja jest `held`, ma `payment.sessionId` i jeszcze nie wygasła, serwer pyta Stripe o sesję. Jeśli jest opłacona, przyjmuje płatność tą samą funkcją co webhook (strona powrotu nie czeka wtedy na spóźniony webhook). Odrzucenia i zwroty robi tylko webhook.
- **[E2] Limit ruchu (D7):** klucz to IP z `x-real-ip`, potem pierwszy adres z `x-forwarded-for`, a gdy brak obu: `"local"`. Okno stałe: `RATE_LIMIT_MAX` żądań na `RATE_LIMIT_WINDOW_SECONDS`. Po przekroczeniu `429` + `Retry-After: <sekundy do końca okna>`. Limit sprawdzamy **przed** walidacją, więc liczą się też złe żądania.
- Zły `:id` (nie `^[0-9a-f]{24}$`, `%7B%7D`, bardzo długi) → `404`, nigdy `500`. Zepsute `%`-kodowanie odrzuca Next.js (`400` HTML) — świadomie zostawiamy.

### [E3] Punkty — szczegóły

Stałe i rachunki są w jednym miejscu, `src/lib/points.ts` (lider): `WELCOME_POINTS = 1000`, `POINTS_PER_ZLOTY = 10`, `maxPointsFor(amount) = floor(amount / 2)`, `pointsEarnedFor(cardAmount) = floor(cardAmount / 100) × 10`. Przykład pociągu: cena 8900, nowy klient wydaje 1000 → `cardAmount` 7900, `pointsEarned` 790.

**Walidacja `points` w checkoucie (D22):**
- body puste, `{}` albo bez pola `points` → jak `points: 0`; body to nie obiekt JSON albo > 10 kB → `400 VALIDATION_ERROR`,
- `points` musi być liczbą całkowitą `0 ≤ points` (`Number.isSafeInteger`). String, ułamek, ujemna, `NaN`, `null`, obiekt → `400 VALIDATION_ERROR`,
- `points > maxPointsFor(amount)` → `400 POINTS_OVER_LIMIT`, bez wołania Voucherify,
- inne pola body (np. `amount`) ignorujemy.

**Checkout z punktami (karta B, D15–D16) — kolejność:**
1. limit ruchu, potem rezerwacja jak w Etapie II (`404/410/409 ALREADY_PAID`),
2. rezerwacja ma już `payment` → `points` brak albo równe `pointsUsed` → ten sam `url`; inne → `409 POINTS_LOCKED`,
3. `points = 0` → `pointsUsed: 0`, `cardAmount: amount`, sesja Stripe jak w Etapie II. **Voucherify nie jest wołany.**
4. `points > 0` → atomowe zajęcie `loyalty.spend` (`pending`, zapisuje `pointsUsed` i `cardAmount`; warunek: `held`, ważna, bez `payment`, `spend` brak/`retry`/`failed`). Przegrany z tą samą liczbą punktów czeka do 8 s, aż zwycięzca skończy, i dostaje ten sam `url`; z inną → `409 POINTS_LOCKED`,
5. blokada e-maila w `loyalty_members.spendLockUntil` (15 s); zajęta → `409 LOYALTY_BUSY` „Spróbuj za chwilę” i `spend` wraca na `retry`,
6. świeże saldo z Voucherify (karta zakładana przy pierwszym użyciu, D14). `saldo < points` → `409 INSUFFICIENT_POINTS`, `spend: failed`, `pointsUsed` i `cardAmount` czyszczone,
7. pobranie punktów: `points: −pointsUsed`, `reason: "spend-<reservationId>"`, **czekamy na `APPROVED`** (§3, „Operacje na punktach”) → `spend: done`; `REJECTED` (portfel nie pozwala zejść poniżej zera) → `409 INSUFFICIENT_POINTS`, `spend: failed`; wciąż `PENDING` po ~4 s → `spend: retry` i `503 LOYALTY_UNAVAILABLE`. Na końcu zwolnienie blokady,
8. sesja Stripe na `cardAmount`, metadata dodatkowo `pointsUsed`. Opis pozycji: „Wagon 1, miejsce 5 · … · punkty: −10,00 zł”. Błąd Stripe → `503 PAYMENT_UNAVAILABLE`, punkty zostają pobrane (`spend: done`), a ponowne „Zapłać” tworzy sesję bez ponownego pobrania. Jeśli klient nie zapłaci, punkty wracają przy wygaśnięciu (D17).

**Operacje na punktach (Voucherify v2 nie ma kluczy idempotencji, a zmiany są asynchroniczne):**
- endpointy (`{p}` = `VOUCHERIFY_PROGRAM_ID`): członkostwo z saldem `GET /v2/loyalties/programs/{p}/memberships/{encodeURIComponent(email)}?identification_type=customer_source_id` (e-mail zawsze kodowany — `+` w `delivered+jan@resend.dev`!; `404` = brak; saldo w `cards[].card.balance.points` karty z naszym portfelem), zmiana punktów `POST /v2/loyalties/programs/{p}/members/{memberId}/cards/{cardId}/points` z `{ points, reason }` → transakcja `lctx_…`, lista transakcji karty `GET …/cards/{cardId}/transactions` (filtry po `id` i `created_at`, `reason` w `details.reason`),
- **`reason` jest naszym identyfikatorem operacji i jest unikalny:** `spend-<reservationId>`, `refund-<reservationId>`, `earn-<reservationId>`, `welcome-<email>`,
- **pobranie punktów i punkty powitalne** czekamy do `APPROVED`: odpytujemy transakcję po `id` (np. po 0,5 / 1 / 1,5 s, najwyżej ~4 s). **Dodanie punktów** (zwrot, naliczenie) uznajemy za zrobione, gdy Voucherify przyjął żądanie (`2xx` z `lctx_…`) — dodania portfel nie odrzuca,
- **przed każdym ponowieniem** (krok `retry` albo `pending` starszy niż 2 min) szukamy na liście transakcji karty naszego `reason` z ostatnich 24 h. Jest `APPROVED`/`PENDING`/`PROCESSING` → operacja już poszła, nie wysyłamy drugi raz (dla pobrania czekamy na wynik). Jest `REJECTED` albo brak → wysyłamy ponownie,
- timeout albo zerwane połączenie przy `POST` = nie wiadomo, czy doszło → od razu takie samo sprawdzenie po `reason`. Pobranie punktów bez pewności → `spend: retry` i `503 LOYALTY_UNAVAILABLE` (klient klika jeszcze raz, a sprawdzenie po `reason` nie pozwoli pobrać dwa razy).

**Zwrot punktów — `settleLoyalty` (D17, karta A):**
- dotyczy rezerwacji z `loyalty.spend.status: "done"`, która nie jest `paid` i jest zamknięta (`active: false`) albo minęło 30 s od `expiresAt` (D8 przyjmuje płatność do 10 s po czasie — 30 s to zapas),
- jedno atomowe `findOneAndUpdate` ustawia `status: "expired"`, `active: false` i `loyalty.refund: pending`. Od tej chwili `acceptPayment` jej nie opłaci (warunek `held` + `active`), a spóźniona płatność dostaje zwrot pieniędzy jak w Etapie II,
- potem `+pointsUsed` na kartę (`reason: "refund-<id>"`) → `refund: done`,
- wołają ją: `GET /api/reservations/:id` (ta rezerwacja), `GET /api/loyalty` i `GET /api/reservations/:id/points` (wszystkie rezerwacje tego e-maila, **przed** odczytem salda — klient od razu widzi oddane punkty), webhook po zwrocie pieniędzy za spóźnioną płatność, `/api/cron/settle` (wszystkie zaległe). Wywołanie Voucherify przez `after()`, z wyjątkiem odczytu salda, który czeka na zwrot, żeby pokazać właściwą liczbę.

**Punkty za zakup — `earnForPurchase` (D18, karta A):** `acceptPayment` w tym samym atomowym przejściu do `paid` zapisuje `pointsEarned` i `loyalty.earn: pending`. Po odpowiedzi (`after()`) `+pointsEarned` na kartę (`reason: "earn-<id>"`), karta zakładana przy pierwszym użyciu z 1000 powitalnymi. Błąd → `retry`; ponawia `GET /api/reservations/:id`, `GET /api/loyalty` tego e-maila i cron. `pointsEarned` w API jest od razu po opłaceniu, niezależnie od tego, czy Voucherify już je zapisał.

**Mail z biletem — `sendTicketEmail` (D19, karta C):** po przyjęciu płatności (webhook i synchronizacja w GET) przez `after()`. Atomowe zajęcie `ticketEmail` (brak/`retry` → `sending`), potem Resend z `Idempotency-Key: ticket-<reservationId>`. Sukces → `sent` + `resendId`. `429`/`5xx`/sieć → `retry` (ponawia GET rezerwacji i cron, najwyżej 5 prób). `4xx` (np. `403` dla adresu spoza testowych) → `failed`, bez ponawiania. Treść: kod biletu, kurs, odjazd (Europe/Warsaw), wagon i miejsce, pasażer, „Zapłacono kartą: 79,00 zł”, „Zapłacono punktami: 1000 pkt (10,00 zł)”, „Zebrane punkty: 790”, link `APP_URL/reservations/<kod>`. Wszystkie dane klienta w HTML przez escape (Z48). Wersja `text` obok `html`.

**`GET /api/loyalty`:** limit ruchu (kubełek `loyalty`, D7), walidacja e-maila jak w rezerwacji (`400`), normalizacja D13, `settleLoyalty` dla tego e-maila, potem saldo: karta `ready` → Voucherify (albo pamięć podręczna, jeśli młodsza niż 30 s); `absent` sprawdzone w ciągu 10 min → 1000 bez wołania Voucherify; brak wpisu → jedno wyszukanie karty klienta w Voucherify. Odpowiedź zawiera tylko `email` i `points`.

**Budżet wywołań Voucherify (100/h na projekt w sandboxie):**

| Sytuacja | Wywołania |
|---|---|
| saldo nowego e-maila (`GET /api/loyalty`) | 1, potem 10 min z pamięci |
| saldo znanego klienta | 1, potem 30 s z pamięci |
| zakup bez punktów — nowy klient | 0 przy „Zapłać”; po zapłacie ~5 (klient, członek, +1000, sprawdzenie +1000, +punkty) |
| zakup bez punktów — znany klient | 0 przy „Zapłać”; po zapłacie 1 |
| zakup z punktami — nowy klient | ~9 (saldo, klient, członek, +1000 i sprawdzenie, pobranie i 1–2 sprawdzenia, +punkty) |
| zakup z punktami — znany klient | ~4–5 |

Czyli kilkanaście zakupów na godzinę na cały zespół i CEO — dlatego lokalnie `memory`, a atak na produkcji ma budżet (PROMPTY M3). `429` od Voucherify traktujemy jak niedostępność (D20) i zapisujemy czas z `Retry-After` / `X-Rate-Limit-Retry`; do tej chwili nie wołamy Voucherify wcale (pamiętane w procesie i w `loyalty_members` pod `_id: "__rate_limit__"`).

**Limit ruchu [E3]:** kubełki `reservations`, `checkout` jak w Etapie II, nowy `loyalty` dla `GET /api/loyalty` i `GET /api/reservations/:id/points` (40 / 10 s / IP). Cron i webhook bez limitu.

## §4. Format błędów

```json
{ "error": "SEAT_TAKEN", "message": "To miejsce jest już zajęte." }
```

- `error` — stały kod: `VALIDATION_ERROR`, `INVALID_SEAT`, `EVENT_NOT_FOUND`, `EVENT_DEPARTED`, `SEAT_TAKEN`, `RESERVATION_NOT_FOUND`, `RESERVATION_EXPIRED`, `TICKET_NOT_FOUND`, `INTERNAL_ERROR`, **[E2]** `ALREADY_PAID` (409), `PAYMENT_REQUIRED` (402), `RATE_LIMITED` (429), `INVALID_SIGNATURE` (400), `PAYMENT_UNAVAILABLE` (503), **[E3]** `POINTS_OVER_LIMIT` (400, „Punktami zapłacisz najwyżej połowę ceny: 4450 pkt.”), `INSUFFICIENT_POINTS` (409, „Masz za mało punktów: 820 pkt.”), `POINTS_LOCKED` (409, „Punkty dla tej płatności są już ustalone: 1000 pkt.”), `LOYALTY_BUSY` (409, „Trwa inna płatność punktami tego klienta. Spróbuj za chwilę.”), `LOYALTY_UNAVAILABLE` (503, „Punkty chwilowo nie działają. Możesz zapłacić bez punktów.”), `UNAUTHORIZED` (401, cron).
- `message` — po polsku, dla człowieka. Helper: `jsonError(status, error, message)`, **[E2]** `rateLimited(retryAfterSeconds)` z `src/lib/errors.ts`.
- `5xx` nigdy nie zawiera stack trace, treści wyjątku ani komunikatu Stripe, **[E3]** Voucherify ani Resend. Szczegóły tylko w `console.error`.
- **[E3]** Odmowy punktowe mają dodatkowe pole liczbowe, żeby frontend nie parsował komunikatu: `POINTS_OVER_LIMIT` → `maxPoints`, `INSUFFICIENT_POINTS` → `balance`, `POINTS_LOCKED` → `pointsUsed`.

## §5. Strony i przepływ

| Strona | Co | Karta |
|---|---|---|
| `/` | rozkład jazdy, **[E2]** z ceną | A (Kamil) |
| `/events/:id` | mapa wagonu, **[E2]** z ceną miejsca | A (Kamil) |
| `/reserve?eventId=…&seatId=…` | formularz, **[E2]** z ceną | Mateusz |
| `/reservations/:param` | reservationId → licznik + **[E2]** „Zapłać 89,00 zł”; kod → bilet | Mateusz |
| **[E2]** `/payment/success?reservationId=…` | „Płatność w toku…” → sama zamienia się w bilet | C (Mateusz) |
| **[E2]** `/payment/cancel?reservationId=…` | „Płatność przerwana” + „Zapłać ponownie”, dopóki rezerwacja jest ważna | C (Mateusz) |
| **[E3]** `/reserve` | po wpisaniu poprawnego e-maila: „Masz 1000 pkt (10,00 zł)” (GET `/api/loyalty`, z opóźnieniem 500 ms po pisaniu, jedno żądanie naraz) | A (Mateusz) |
| **[E3]** `/reservations/:param` (licznik) | pole „Użyj punktów” z podpowiedzią „najwięcej 1000 pkt” i przyciskiem „Użyj wszystkich”; cena i przycisk zmieniają się od razu: „Zapłać 79,00 zł”; po pierwszym „Zapłać” pole zablokowane (D16) | B (Mateusz) |
| **[E3]** `/reservations/:kod` (bilet) i `/payment/success` | podsumowanie: „Kartą 79,00 zł · punktami 1000 pkt (10,00 zł) · zebrane punkty: 790” | C (Mateusz) |

Przepływ (dane tylko przez URL, bez localStorage):
1. Mapa → `/reserve` → `POST /api/reservations` → `/reservations/<reservationId>` (licznik, cena).
2. „Zapłać 89,00 zł” (**[E3]** albo „Zapłać 79,00 zł” z punktami) → `POST /api/reservations/:id/checkout` (**[E3]** body `{ points }`) → `window.location.assign(url)` → strona Stripe.
3. Zapłacone → Stripe wraca na `/payment/success?reservationId=…` → strona odpytuje `GET /api/reservations/:id` co 2 s (do 60 s) → `paid` → `router.replace("/reservations/<code>")` → bilet.
4. Przerwane („Wróć” na stronie Stripe) → `/payment/cancel?reservationId=…` → licznik + „Zapłać ponownie” (ten sam `url`); po czasie „Rezerwacja wygasła, miejsce wróciło do puli”.
5. **Bilet nigdy nie wynika z samego adresu powrotu** — tylko z `status: "paid"` w bazie.

## §6. Właściciele plików

Edytujesz tylko swoje pliki. Zmiana w cudzym pliku = wiadomość do lidera. Wyjątek: lider robi szkielet (M1) i drobne poprawki po przeglądzie. Właściciel pliku się nie zmienia.

**[E3] Karty Etapu III:** Eryk — **karta A (konto punktowe)**, Kamil — **karta B (płatność punktami)**, Mateusz — **karta C (mail z biletem)** i cały frontend punktów.

| Osoba | Pliki |
|---|---|
| **Mateusz** (lider, karta C + frontend) | `CONTRACT.md`, `PROMPTY*.md`, `README.md`, `DEPLOY.md`, `DEMO.md`, `package.json` i lockfile, configi (w tym **[E3]** `vercel.json`), `.env.example`, `src/app/layout.tsx`, `src/app/globals.css`, `src/app/not-found.tsx`, `src/lib/types.ts`, `src/lib/errors.ts`, `src/lib/format.ts`, **[E3]** `src/lib/points.ts`, **[E3]** `src/lib/mail.ts`, **[E3]** `src/lib/after.ts`, `src/components/brand/**`, `src/components/reservation/**`, `src/components/payment/**`, **[E3]** `src/components/loyalty/**`, `src/app/reserve/**`, `src/app/reservations/**`, `src/app/payment/**`, `scripts/attack.mjs`, `scripts/reset.ts` |
| **Kamil** (karta B: płatność punktami) | `src/data/events.ts`, `scripts/seed.ts`, `src/lib/events.ts`, `src/lib/seats.ts`, `src/app/page.tsx`, `src/app/events/**`, `src/app/api/events/**`, `src/components/events/**`, `src/lib/stripe.ts`, `src/lib/checkout.ts`, `src/lib/rateLimit.ts`, `src/app/api/reservations/[id]/checkout/**`, **[E3]** `src/lib/spend.ts`, **[E3]** `src/app/api/reservations/[id]/points/**` |
| **Eryk** (karta A: konto punktowe) | `src/lib/db.ts`, `src/lib/config.ts`, `src/lib/reservations.ts`, `src/lib/validation.ts`, `src/app/api/reservations/**` (bez `checkout` i `points`), `src/app/api/tickets/**`, `src/lib/payments.ts`, `src/app/api/webhooks/**`, **[E3]** `src/lib/voucherify.ts`, **[E3]** `src/lib/loyalty.ts`, **[E3]** `src/app/api/loyalty/**`, **[E3]** `src/app/api/cron/**`, `tests/**`, `vitest.config.mts` |

Testy: `tests/**` należą do Eryka, ale **każdy dopisuje testy swojej karty w nowym pliku** (`tests/spend.test.ts` — Kamil, `tests/mail.test.ts` — Mateusz). Wspólne `tests/setup-env.ts` i `tests/helpers.ts` zmienia tylko Eryk albo lider w szkielecie. W testach zawsze `LOYALTY_PROVIDER=memory` i `MAIL_PROVIDER=log` — żaden test nie woła prawdziwego Voucherify ani Resend.

Funkcje współdzielone (sygnatur nie zmieniamy; szkielet daje zaślepki):
- `getTakenSeats(eventId)` — Eryk; woła Kamil. `getEvent(id)` — Kamil; woła Eryk.
- **[E2]** `getStripe()`, `rateLimit(req, bucket)` — Kamil. **[E3]** `bucket` dochodzi `"loyalty"`.
- **[E2]** `getCheckoutCandidate(id)` — Eryk; woła Kamil (bez zmian).
- **[E3]** `saveCheckoutSession(id, { sessionId, url, pointsUsed, cardAmount }): Promise<void>` — Eryk; zapisuje `payment` (i dla `pointsUsed: 0` także `pointsUsed`/`cardAmount`) tylko gdy rezerwacja jest `held`, nie ma sesji, a przy `pointsUsed > 0` ma `loyalty.spend.status: "done"` z tą samą liczbą punktów. Woła Kamil.
- **[E3]** `claimPointsSpend(id, points): Promise<{ ok: true; reservation: Reservation } | { ok: false; error: "RESERVATION_NOT_FOUND" | "RESERVATION_EXPIRED" | "ALREADY_PAID" | "POINTS_LOCKED" | "SPEND_IN_PROGRESS"; pointsUsed?: number }>` — Eryk (`reservations.ts`); atomowe zajęcie `loyalty.spend` z §3 krok 4. Woła Kamil.
- **[E3]** `finishPointsSpend(id, status: "done" | "retry" | "failed"): Promise<void>` — Eryk; `failed`/`retry` czyści `pointsUsed` i `cardAmount`. Woła Kamil.
- **[E3]** `src/lib/voucherify.ts` (Eryk): `getLoyaltyClient(): LoyaltyClient` — `findMember(email)` → `{ memberId, cardId, balance } | null`, `createMember(email)` → `{ memberId, cardId, created }` (upsert klienta + członek; `409` → istniejący, `created: false`), `addPoints(memberId, cardId, points, reason)` → `{ transactionId }` (ujemne = pobranie), `getTransaction(memberId, cardId, transactionId)` → `{ status }`, `findTransactionByReason(memberId, cardId, reason, since)` → `{ transactionId, status } | null`. Błędy: `LoyaltyUnavailableError { retryAfterSeconds?: number; uncertain: boolean }` (`uncertain` = żądanie mogło dojść: timeout, zerwane połączenie). Implementacje `voucherify` i `memory` (D21).
- **[E3]** `src/lib/loyalty.ts` (Eryk): `normalizeEmail(email): string`, `getPoints(email): Promise<number>` (z `settleLoyalty` i pamięcią podręczną), `getFreshBalance(email): Promise<number>` (zawsze z Voucherify, 1000 dla e-maila bez karty), `ensureMember(email): Promise<{ memberId: string; cardId: string }>` (zakłada członka i dodaje 1000 raz, czeka na `APPROVED` powitalnych), `applyPoints(email, points, reason, { waitForApproval }): Promise<"done" | "rejected" | "retry">` (zakłada kartę przez `ensureMember`, zasady z „Operacji na punktach”; `waitForApproval: true` dla pobrania), `acquireSpendLock(email): Promise<boolean>`, `releaseSpendLock(email): Promise<void>`, `settleLoyalty(target: { reservationId: string } | { email: string }): Promise<void>`, `earnForPurchase(reservationId): Promise<void>`, `runLoyaltyRetries(): Promise<{ refunded: number; earned: number }>`. Woła Kamil (`spend.ts`, `points` route) i lider (cron w szkielecie).
- **[E3]** `src/lib/spend.ts` (Kamil): `spendPointsForCheckout(reservationId, points): Promise<SpendResult>` — kroki 4–7 z §3. Woła `checkout.ts`.
- **[E3]** `src/lib/mail.ts` (Mateusz): `sendTicketEmail(reservationId): Promise<void>` (nigdy nie rzuca), `retryTicketEmails(): Promise<number>`. Woła Eryk (`payments.ts`, `reservations.ts`, cron).
- **[E3]** `src/lib/payments.ts` (Eryk): po każdym przyjęciu płatności `runAfterResponse("payments:after", () => Promise.allSettled([earnForPurchase(id), sendTicketEmail(id)]))`.
- **[E3]** `src/lib/after.ts` (Mateusz): `runAfterResponse(context, task)` — `after()` z `next/server`, a poza żądaniem (testy, skrypty) czeka na zadanie od razu; błąd zadania tylko w logu.
- **[E3]** `src/lib/points.ts` (Mateusz): stałe i rachunki z §3; `formatPoints(n)` → `"1000 pkt"`. Używają wszyscy — **nikt nie liczy punktów inaczej**.

Git: branch na kartę, PR do `master`, review robi lider. Conventional Commits.
- `feature/e3-skeleton` (Mateusz, wchodzi pierwszy),
- `feature/e3-spend` (Kamil),
- `feature/e3-loyalty` (Eryk),
- `feature/e3-mail-frontend` (Mateusz),
- `feature/e3-attack` (Mateusz).

## §7. Lista zagrożeń

Z1–Z21 z Etapu I i Z22–Z35 z Etapu II obowiązują dalej (zakup = teraz płatność). Kryteria CEO w nawiasach.

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

### [E3] Zagrożenia Etapu III

Punkty i maile to dwie nowe zewnętrzne usługi, tak jak Stripe. Kryteria Etapu III jeszcze nie przyszły — tabela opiera się na PDF-ie etapu i kryteriach I–II.

| # | Zagrożenie | Obrona | Kto |
|---|---|---|---|
| **Z36** | Ten sam klient wydaje punkty równolegle na dwie rezerwacje i schodzi poniżej zera | blokada e-maila `spendLockUntil` + świeże saldo z Voucherify tuż przed pobraniem; druga płatność → `409 LOYALTY_BUSY` | Kamil + Eryk |
| **Z37** | Złe `points`: ujemne, ułamek, string, `1e9`, więcej niż połowa ceny | walidacja → `400 VALIDATION_ERROR` / `400 POINTS_OVER_LIMIT`, Voucherify nie jest wołany | Kamil |
| **Z38** | Podwójne „Zapłać” z punktami (C1) pobiera punkty dwa razy | atomowe zajęcie `loyalty.spend`; przegrany czeka i dostaje ten sam `url` | Kamil + Eryk |
| **Z39** | Punkty pobrane, a klient nie zapłacił (rezerwacja wygasła) | `settleLoyalty` oddaje punkty (D17): przy odczycie rezerwacji, przy odczycie salda, codzienny cron | Eryk |
| **Z40** | Płatność kartą po wygaśnięciu rezerwacji z punktami (II.A2) | zwrot pieniędzy (D8) i zwrot punktów; zwrot punktów zamyka rezerwację atomowo, więc nie ma „biletu za darmo” | Eryk |
| **Z41** | Punkty za zakup naliczone dwa razy (powtórka webhooka, webhook + GET, ponowienie) | `pointsEarned` + `loyalty.earn: pending` w tym samym przejściu do `paid`; jeden wykonawca; unikalny `reason` + sprawdzenie transakcji przed ponowieniem | Eryk |
| **Z42** | Punkty liczone od całej ceny, od groszy albo zaokrąglone w górę | jeden wzór `pointsEarnedFor(cardAmount)` w `points.ts`; test na 7900 → 790, 4450 → 440, 99 → 0 | wszyscy |
| **Z43** | Voucherify nie działa albo limit 100/h (`429`) | bez punktów płacisz jak w Etapie II (zero wywołań Voucherify); z punktami `503 LOYALTY_UNAVAILABLE`; saldo z pamięci podręcznej; naliczenia i zwroty czekają na ponowienie (D20) | Eryk + Kamil |
| **Z44** | Timeout przy zmianie salda — nie wiadomo, czy punkty zeszły | sprawdzenie transakcji po `reason` przed decyzją; pobranie liczy się dopiero po `APPROVED`; nigdy sesja Stripe ze zniżką bez `spend: done` | Eryk + Kamil |
| **Z45** | Klient zmienia liczbę punktów po otwarciu strony Stripe i płaci starą sesją | punkty zablokowane po pierwszym „Zapłać” → `409 POINTS_LOCKED` (D16); webhook sprawdza `amount_total === cardAmount` | Kamil + Eryk |
| **Z46** | Mail z biletem wysłany dwa razy (webhook + GET, powtórka) | atomowe zajęcie `ticketEmail` + `Idempotency-Key: ticket-<id>` w Resend (24 h) | Mateusz |
| **Z47** | Mail nie wychodzi (Resend nie działa, `bounced@`, adres spoza testowych `403`) | bilet i odpowiedzi API bez zmian; `ticketEmail: retry/failed`, ponowienie do 5 razy; strona biletu działa bez maila | Mateusz |
| **Z48** | HTML/link w imieniu wstrzyknięty do maila | escape wszystkich danych klienta w HTML, link do biletu z `APP_URL` | Mateusz |
| **Z49** | Ktoś sprawdza saldo cudzego e-maila (`GET /api/loyalty`) | świadomie dozwolone przez PDF; odpowiedź tylko `{ email, points }`, limit ruchu; ujawnia mniej niż mail od marketingu | Eryk |
| **Z50** | Klucze Voucherify/Resend w repo, w przeglądarce albo w odpowiedzi błędu | tylko env serwera, bez `NEXT_PUBLIC_`; treść błędów usług tylko w `console.error` | wszyscy |
| **Z51** | 1000 punktów powitalnych dodane dwa razy (dwa pierwsze zakupy naraz) | atomowe `creating` w `loyalty_members`, `welcome: pending → done`, `reason: "welcome-<email>"` sprawdzany przed ponowieniem; `409 member_already_exists` = bez powitalnych | Eryk |
| **Z52** | `Jan@Example.com` i `jan@example.com` jako dwa konta | normalizacja D13 wszędzie: rezerwacja, saldo, Voucherify | Eryk |
| **Z53** | Kwota z body checkoutu (`{ "amount": 100 }`, II.A1) | body: liczy się tylko `points` (D22); kwota z bazy | Kamil |
| **Z54** | Zostawione punkty lub maile po awarii funkcji na Vercelu w połowie operacji | kroki `pending` starsze niż 2 min ponawia GET i dzienny cron (`/api/cron/settle`), po sprawdzeniu transakcji | Eryk + Mateusz |
| **Z55** | Voucherify przyjął pobranie punktów, ale je odrzucił albo jeszcze przetwarza (v2 jest asynchroniczne) | sesja Stripe dopiero po `APPROVED`; `REJECTED` → `409 INSUFFICIENT_POINTS`; dalej `PENDING` → `503` i sprawdzenie po `reason` przy następnym kliknięciu | Kamil + Eryk |
