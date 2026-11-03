# PROMPTY.md — prompty dla agentów (Etap II, płatności Stripe)

Prompty Etapu I: [PROMPTY-ETAP-1.md](PROMPTY-ETAP-1.md).

Kolejność:
1. ✅ **Mateusz — M1 (szkielet Etapu II + konto Stripe)** — PR #9.
2. ✅ **Kamil — K2** — PR #11. ✅ **Eryk — E2** — PR #12. ✅ **Mateusz — M2** — PR #10.
3. ✅ **Mateusz — M3 (spięcie, atak, demo)** — PR z `feature/e2-attack`. Zostaje konfiguracja Vercela i webhooka w panelu Stripe (DEPLOY.md §2–§3) i test kart na produkcji (§6).

Każdy pracuje na świeżym `master` (`git checkout master && git pull`). W `.env.local` każdy ma: `MONGODB_URI`, własną `MONGODB_DB`, `STRIPE_SECRET_KEY` (testowy, od lidera), `STRIPE_WEBHOOK_SECRET` (z własnego `stripe listen`), `APP_URL=http://localhost:3000`. Kluczy nie wklejamy do czatu ani do repo.

Stripe CLI (każdy, raz):

```bash
brew install stripe/stripe-cli/stripe
```

```bash
stripe login
```

---

## Prompt M1 — Mateusz: szkielet Etapu II

```
Jestem liderem 3-osobowego zespołu w projekcie PAS S01: system rezerwacji biletów na POCIĄG „Konduktor” (Next.js 15 App Router + TypeScript + MongoDB + Tailwind). Etap I działa i jest na produkcji. Etap II: płatność kartą przez Stripe Checkout (tryb testowy) zamiast „Kupuję bilet”. Oceniana jest NIEZAWODNOŚĆ.
Przeczytaj CONTRACT.md w całości — to źródło prawdy, szczególnie §0 (decyzje), §2, §3, §6. Nie zmieniaj go bez pytania mnie.
Pracuj na branchu feature/e2-skeleton z aktualnego master.

ZADANIE: szkielet Etapu II, żeby Kamil (karta A: checkout + limit ruchu) i Eryk (karta B: webhook + backend karty C) mogli od razu pracować równolegle na zaślepkach. Mam wyjątek z §6: w szkielecie wolno mi ruszyć pliki wszystkich.

1. Zależność: `npm install stripe` (najnowsza wersja). Nic więcej do package.json.
2. Mechaniczna zmiana D1 w CAŁYM repo (src, tests, scripts): status "purchased" → "paid", pole purchasedAt → paidAt (także w odpowiedzi GET /api/tickets/:code). Tylko zmiana nazw, bez zmiany logiki. Po zmianie npm test musi przechodzić (baza z MONGODB_URI w .env.local, testy same biorą pociag_test).
3. src/lib/types.ts: TrainEvent.price, Reservation.amount, paidAt, payment (dokładnie jak §2), ReservationStatus "held" | "paid" | "expired", CreateReservationResponse z amount, ReservationResponse z amount, TicketResponse z amount i paidAt, CheckoutResponse { url }, nowe ErrorCode z §4.
4. src/lib/errors.ts: rateLimited(retryAfterSeconds) → 429 RATE_LIMITED z nagłówkiem Retry-After i komunikatem po polsku. src/lib/format.ts: formatPrice(grosze) → "89,00 zł" (Intl, pl-PL, PLN).
5. Zaślepki z komentarzem `// STUB — implementuje <Imię>`, działające bez Stripe i bez kluczy:
   - [Kamil] src/data/events.ts: dopisz price wg D4 (to dane, nie zaślepka — wpisz od razu). src/lib/events.ts: dodaj price do projekcji.
   - [Kamil] src/lib/stripe.ts: getStripe() i klasa PaymentUnavailableError (zaślepka rzuca PaymentUnavailableError).
   - [Kamil] src/lib/rateLimit.ts: rateLimit(req, bucket) → zawsze { ok: true }.
   - [Kamil] src/lib/checkout.ts + POST /api/reservations/[id]/checkout/route.ts: woła getCheckoutCandidate i zwraca 200 { url: APP_URL + "/payment/success?reservationId=<id>" } (bez Stripe), błędy z kandydata → 404/410/409 wg §3.
   - [Eryk] src/lib/reservations.ts: createReservation zapisuje amount = event.price i zwraca je; getCheckoutCandidate(id) i saveCheckoutSession(id, { sessionId, url }) wg §6 (prosta, poprawna wersja). GET /api/reservations/:id zwraca amount.
   - [Eryk] POST /api/reservations/[id]/purchase: wg D5 (held → 402 PAYMENT_REQUIRED, paid → 200 { code }, expired → 410, zły id → 404). Funkcja purchaseReservation w src/lib zostaje na razie jako wewnętrzna (używają jej testy Etapu I); route jej już nie woła. Żadnych furtek do „darmowego” biletu.
   - [Eryk] src/lib/payments.ts: handleStripeEvent(event) i syncCheckoutSession(reservationId) — zaślepki bez efektu. src/app/api/webhooks/stripe/route.ts: czyta surowe body (await req.text()), na razie zawsze 200 { received: true }.
   - [Mateusz] src/app/payment/success/page.tsx i src/app/payment/cancel/page.tsx: proste strony czytające reservationId z URL (useSearchParams w <Suspense>) i pokazujące status z GET /api/reservations/:id.
   - [Mateusz] HoldView: przycisk „Zapłać <formatPrice(amount)>” → POST checkout → window.location.assign(url). Licznik i reszta bez zmian.
   - Wszystkie nowe route'y: export const dynamic = "force-dynamic", withErrorHandling, w Next 15 params to Promise.
6. .env.example: nowe zmienne z §1 z komentarzami. README: sekcja „Stripe lokalnie” (stripe login, stripe listen --forward-to localhost:3000/api/webhooks/stripe, skąd wziąć whsec_, karty testowe 4242…, 4000 0000 0000 0002, 4000 0025 0000 3155).
7. Aktualizuj istniejące testy tylko tam, gdzie zmieniła się nazwa statusu albo zachowanie route'u /purchase (testy na poziomie src/lib dalej wołają purchaseReservation; testy HTTP /purchase oczekują teraz 402 dla held). Nie kasuj scenariuszy Z1–Z5.

DEFINICJA "GOTOWE": npm run build, npm run lint, npm test zielone; npm run seed wgrywa ceny; przeklikanie: mapa → formularz (cena) → licznik → „Zapłać 89,00 zł” → /payment/success (zaślepka); curl każdego endpointu z §3 zwraca kształt z kontraktu (checkout bez Stripe).
Zanim zaczniesz, pokaż krótki plan. Małe commity (Conventional Commits), na koniec opis PR z listą plików i właścicieli.

POZA KODEM (zrób sam w przeglądarce, agent tylko przypomina): konto Stripe w trybie testowym (nazwa firmy: Konduktor), zaproś Kamila i Eryka (rola Developer) oraz nauczyciela (rola View only / tylko odczyt), klucz sk_test_ przekaż zespołowi prywatnie (nie w repo, nie w czacie z agentem).
```

---

## Prompt K2 — Kamil: karta A (Checkout) + limit ruchu

```
Pracuję w 3-osobowym zespole nad projektem PAS S01: system rezerwacji biletów na POCIĄG „Konduktor” (Next.js 15 App Router + TypeScript + MongoDB + Stripe). Etap II: płatność przez Stripe Checkout w trybie testowym. Oceniana jest NIEZAWODNOŚĆ — CEO atakuje API.
Przeczytaj CONTRACT.md w całości (szczególnie §0, §1, §2, §3, §6, §7 Z23, Z26, Z29, Z32–Z34). Nie zmieniaj kontraktu ani plików innych osób (§6) — jeśli trzeba, zatrzymaj się i napisz mi, co i dlaczego. Nie dodawaj zależności (stripe już jest).
Pracuj na branchu feature/e2-checkout z aktualnego master. Szkielet ma zaślepki.

MOJA KARTA: A — Checkout (cena, przejście do Stripe) + kryterium B5 (limit ruchu).

1. Ceny: src/data/events.ts ma price (D4) — sprawdź, npm run seed je wgrywa (idempotentnie). Rozkład jazdy (/) i mapa (/events/:id): pokaż cenę miejsca przez formatPrice z src/lib/format.ts („89,00 zł”), np. w wierszu kursu i w nagłówku mapy.
2. src/lib/stripe.ts: getStripe() — jeden klient Stripe na proces (globalThis), klucz z STRIPE_SECRET_KEY czytany przy pierwszym użyciu (nie przy buildzie). Brak klucza albo klucz, który nie zaczyna się od "sk_test_" → rzuć PaymentUnavailableError (D11, Z32). Ustaw maxNetworkRetries: 2 i timeout ~10 s. Nigdy nie loguj klucza.
3. src/lib/checkout.ts + POST /api/reservations/[id]/checkout:
   - najpierw rateLimit(req, "checkout") → 429 przez rateLimited(),
   - zły id → 404; getCheckoutCandidate(id) (Eryk) → RESERVATION_NOT_FOUND 404 / RESERVATION_EXPIRED 410 / ALREADY_PAID 409,
   - jeśli reservation.payment?.url istnieje → 200 { url } bez wołania Stripe (D9),
   - inaczej stripe.checkout.sessions.create z idempotencyKey "checkout-<reservationId>": mode "payment", line_items z price_data { currency: "pln", unit_amount: reservation.amount, product_data { name: "IC 1500 Warszawa Centralna → Kraków Główny", description: "Wagon 2, miejsce 14 · pt., 4 grudnia 2026, odjazd 08:15" } }, quantity 1, client_reference_id = reservationId, metadata { reservationId, eventId, seatId }, customer_email, locale "pl", success_url / cancel_url z APP_URL wg §3 (D10 — NIGDY z nagłówka Host; brak APP_URL → 503 PAYMENT_UNAVAILABLE i log),
   - parametry sesji muszą być DETERMINISTYCZNE (wyliczone tylko z rezerwacji i kursu — żadnego Date.now(), żadnego expires_at), bo Stripe odrzuca ten sam idempotency key z innymi parametrami,
   - saveCheckoutSession(id, { sessionId, url }) (Eryk) → 200 { url },
   - PaymentUnavailableError albo błąd Stripe (StripeError, sieć) → 503 PAYMENT_UNAVAILABLE z ogólnym komunikatem po polsku; szczegóły tylko console.error (Z34). Rezerwacja nietknięta.
   - Body żądania ignoruj — kwota zawsze z bazy (Z29).
4. src/lib/rateLimit.ts — rateLimit(req, bucket) wg D7 i §3 (kryterium B5: 100 rezerwacji w 10 s z jednego IP → 429 z Retry-After, a drugi klient z innego IP rezerwuje bez problemu):
   - IP: x-real-ip, potem pierwszy z x-forwarded-for, inaczej "local"; przytnij i ogranicz długość,
   - okno stałe: windowStart = floor(now / window), dokument { _id: `${bucket}:${ip}:${windowStart}`, count, expiresAt } w kolekcji rate_limits, atomowo findOneAndUpdate({ _id }, { $inc: { count: 1 }, $setOnInsert: { expiresAt } }, { upsert: true, returnDocument: "after" }) — działa na wielu instancjach Vercela,
   - indeks TTL na expiresAt (createIndex raz na proces, jak ensureIndexes),
   - count > RATE_LIMIT_MAX → { ok: false, retryAfterSeconds: sekundy do końca okna, min 1 },
   - RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_SECONDS z env z walidacją (domyślnie 40 / 10),
   - jeśli Mongo rzuci przy liczeniu → przepuść żądanie (fail-open) i zaloguj: limit nie może położyć rezerwacji.
   - Eryk wywoła rateLimit w POST /api/reservations — Ty go nie ruszasz.
5. Testy: dopisz pliki tests/rateLimit.test.ts i tests/checkout.test.ts (tests/ to katalog Eryka, ale nowe pliki z Twoimi testami są OK — nie zmieniaj jego plików ani helpers.ts; potrzebne helpery napisz u siebie). Stripe mockuj (vi.mock("@/lib/stripe")) — testy nie mogą wołać prawdziwego API. Sprawdź: 41. żądanie w oknie → 429 + retryAfter; inne IP niezależne; nowe okno resetuje; checkout: wygasła → 410, opłacona → 409, druga prośba → ten sam url bez drugiego wywołania Stripe; 10 równoległych → jeden url; błąd Stripe → 503 i rezerwacja bez payment.

DEFINICJA "GOTOWE": npm test, npm run lint, npm run build zielone; lokalnie z kluczem sk_test_: rezerwacja → POST checkout → url otwiera stronę Stripe z właściwą kwotą i opisem po polsku; drugi POST → ten sam url; 45 szybkich POST /api/reservations z jednego IP → ostatnie 429 z Retry-After.
Zanim zaczniesz, pokaż krótki plan. Małe commity, na koniec opis PR z listą zagrożeń z §7, które obsłużyłem, i jak to przetestować.
```

---

## Prompt E2 — Eryk: karta B (Webhook) + backend karty C + kryterium B1

```
Pracuję w 3-osobowym zespole nad projektem PAS S01: system rezerwacji biletów na POCIĄG „Konduktor” (Next.js 15 App Router + TypeScript + MongoDB + Stripe). Etap II: płatność przez Stripe Checkout w trybie testowym; bilet z kodem dopiero po potwierdzeniu płatności przez webhook. Oceniana jest NIEZAWODNOŚĆ — moja część jest sercem systemu.
Przeczytaj CONTRACT.md w całości (szczególnie §0 D1, D5, D6, D8, §2, §3, §6, §7 Z22, Z24–Z31, Z34). Nie zmieniaj kontraktu ani plików innych osób — jeśli trzeba, zatrzymaj się i napisz mi. Nie dodawaj zależności (stripe już jest).
Pracuj na branchu feature/e2-webhook z aktualnego master. Szkielet ma zaślepki; status to już "paid".

MOJE KARTY: B — Webhook, backend karty C (status rezerwacji), kryterium Etapu I B1 i wpięcie limitu ruchu.

1. POST /api/webhooks/stripe (src/app/api/webhooks/stripe/route.ts) + src/lib/payments.ts:
   - surowe body: const payload = await req.text(); podpis z nagłówka stripe-signature; getStripe().webhooks.constructEvent(payload, signature, STRIPE_WEBHOOK_SECRET); brak nagłówka / zły podpis / brak sekretu → 400 INVALID_SIGNATURE, nic nie zapisujesz (Z27). Limit body ~1 MB.
   - typy: checkout.session.completed (tylko gdy session.payment_status === "paid") i checkout.session.async_payment_succeeded → acceptPayment(session, eventCreatedAt); inne typy → 200 i outcome "ignored".
   - reservationId = session.client_reference_id (sprawdź format i zgodność z metadata.reservationId).
   - acceptPayment (D8, Z24, Z25): JEDNO atomowe findOneAndUpdate({ _id, status: "held", active: true, expiresAt: { $gt: new Date(eventCreatedAt - 10_000) }, amount: session.amount_total }, { $set: { status: "paid", code, paidAt, "payment.paymentIntentId" } }) + currency === "pln" sprawdzone przed; kolizja kodu → nowy kod (jak w Etapie I).
   - nie trafiło → sprawdź stan: już paid TĄ SAMĄ sesją → nic (powtórka); paid INNĄ sesją → zwrot "duplicate"; wygasła/zwolniona → zwrot "late"/"not_held"; zła kwota/waluta → zwrot "amount_mismatch". Zwrot: getStripe().refunds.create({ payment_intent }, { idempotencyKey: "refund-<sessionId>" }) i $push do payment.refunds. Rezerwacji nie ruszasz (nie oddajesz miejsca, którego nie ma, nie zabierasz cudzego).
   - log w stripe_events: { _id: event.id, type, reservationId, outcome, receivedAt }; to samo event.id drugi raz → 200 bez przetwarzania (Z28). Kolejność: przetwórz (idempotentnie), potem zapisz log — błąd w połowie ma pozwolić Stripe ponowić.
   - błąd bazy albo Stripe przy przetwarzaniu → 500 (bez szczegółów) — Stripe ponowi. Zwrot, który się nie udał → 500, żeby Stripe ponowił.
2. src/lib/reservations.ts:
   - createReservation: amount = event.price (już w szkielecie — sprawdź) i kryterium B1 / D6 (Z22): identyczne żądanie (ten sam eventId, seatId, customerName po trim, email po trim i lowercase) dla AKTYWNEJ rezerwacji → { ok: true, replay: true, reservationId, expiresAt, amount } → route zwraca 200 (pierwsze 201). Działa po kolei i równolegle: po E11000 przeczytaj blokującą rezerwację; jeśli jest tej samej osoby → replay, inaczej SEAT_TAKEN. Zapisuj e-mail już znormalizowany (lowercase).
   - getCheckoutCandidate / saveCheckoutSession (§6) — dopracuj: saveCheckoutSession atomowo tylko gdy status "held" i brak payment.sessionId.
   - getReservation: status held/paid/expired, amount, code tylko przy paid. Gdy held + payment.sessionId + nie wygasła → syncCheckoutSession(id) (Z31): getStripe().checkout.sessions.retrieve; payment_status "paid" → acceptPayment tą samą funkcją co webhook (z czasem = teraz); błąd Stripe → zwróć stan z bazy bez wyjątku. Sync NIGDY nie robi zwrotów — to tylko webhook.
   - getTicketByCode: tylko paid, z amount i paidAt.
3. POST /api/reservations: na początku rateLimit(req, "reservations") (Kamil) → 429 przez rateLimited() (Z23); 201 dla nowej, 200 dla replay, body { reservationId, expiresAt, amount }.
4. /purchase wg D5 (szkielet). Gdy testy przejdą na acceptPayment (punkt 6), usuń wewnętrzną purchaseReservation albo zostaw ją tylko dla testów — żadna ścieżka HTTP nie może wydać biletu bez płatności.
5. src/lib/db.ts: indeks { "payment.sessionId": 1 }; stripe_events nie potrzebuje dodatkowych (unikalne _id).
6. TESTY (vitest, pociag_test, Stripe zmockowany — vi.mock("@/lib/stripe"), podpisy przez prawdziwe stripe.webhooks.generateTestHeaderString z sekretem testowym):
   - webhook bez podpisu / ze złym podpisem → 400, rezerwacja held;
   - checkout.session.completed → paid + kod; ten sam event 2× → jeden kod, bez drugiego zapisu; 2 różne eventy tej samej sesji → jeden kod;
   - płatność po expiresAt + 10 s → brak biletu, refunds.create wywołane raz, miejsce nie wraca do X;
   - wyścig C2 (5×): w chwili wygaśnięcia równolegle webhook X i rezerwacja Y → zawsze dokładnie jeden właściciel, a przegrany X dostaje zwrot;
   - druga sesja dla opłaconej rezerwacji → zwrot "duplicate", kod się nie zmienia;
   - zła kwota albo waluta → zwrot "amount_mismatch", held bez zmian;
   - B1: identyczny POST 2× po kolei i 2× równolegle → jedna rezerwacja, ta sama reservationId (201 + 200); inna osoba → 409;
   - GET rezerwacji: held z sesją opłaconą w Stripe (mock) → paid po samym GET; mock rzuca → stan z bazy, bez 500;
   - /purchase: held → 402, paid → 200 z kodem;
   - wszystkie dotychczasowe testy (Z1–Z21) zielone.

DEFINICJA "GOTOWE": npm test, lint, build zielone; lokalnie ze `stripe listen`: rezerwacja → checkout → karta 4242… → webhook → GET rezerwacji paid z kodem; `stripe trigger checkout.session.completed` nie psuje niczego (brak client_reference_id → ignored, 200); webhook bez podpisu (curl) → 400.
Zanim zaczniesz, pokaż krótki plan. Małe commity, na koniec opis PR z listą zagrożeń z §7, które obsłużyłem, i jak to przetestować.
```

---

## Prompt M2 — Mateusz: frontend płatności (karty A i C)

```
Pracuję w 3-osobowym zespole nad projektem PAS S01: system rezerwacji biletów na POCIĄG „Konduktor” (Next.js 15 App Router + TypeScript + Tailwind). Jestem liderem. Etap II: płatność przez Stripe Checkout. Oceniana jest NIEZAWODNOŚĆ.
Przeczytaj CONTRACT.md w całości (szczególnie §3, §5, §7 Z4, Z30, Z31, Z34, Z35). Nie zmieniaj plików innych osób (§6).
Pracuj na branchu feature/e2-payment-frontend z aktualnego master. Backend może być jeszcze zaślepką — pracuj na kształtach z kontraktu; z kluczem sk_test_ i `stripe listen` przetestuj na prawdziwym Stripe, gdy Kamil i Eryk wejdą do master.

MOJE ZADANIE: wszystko, co klient widzi przy płatności. Komponenty: src/components/reservation/** i src/components/payment/**.

1. Cena wszędzie przez formatPrice: formularz /reserve (nad przyciskiem „Rezerwuję miejsce”: „Cena: 89,00 zł”), ekran rezerwacji, bilet („Zapłacono 89,00 zł”).
2. /reservations/<id> (held): przycisk „Zapłać 89,00 zł” (kwota z amount rezerwacji):
   - blokada na pierwszym kliknięciu (ref, nie tylko state) — Z4,
   - POST /api/reservations/:id/checkout → 200 → window.location.assign(url) (przycisk zostaje zablokowany, tekst „Przechodzę do płatności…”),
   - 410 → stan „wygasła”; 409 ALREADY_PAID → przeładuj stan (GET) i pokaż bilet; 429 → komunikat z Retry-After („Za dużo prób, spróbuj za N s”); 503 PAYMENT_UNAVAILABLE → „Płatności chwilowo nie działają, spróbuj za chwilę” + ponów; błąd sieci → ponów,
   - pod przyciskiem: „Płatność obsługuje Stripe. To tryb testowy — karta 4242 4242 4242 4242, dowolna przyszła data i CVC.”
   - status "paid" przy wejściu → router.replace na /reservations/<code>.
3. /payment/success?reservationId=… (karta C) — „Płatność w toku…”:
   - zły / brak reservationId → komunikat + link do rozkładu,
   - odpytuj GET /api/reservations/:id co 2 s (setTimeout, nie setInterval; przerwij po odmontowaniu), maks. 60 s,
   - paid → router.replace(`/reservations/${code}`) (bilet),
   - expired → „Rezerwacja wygasła przed potwierdzeniem płatności. Jeśli pobraliśmy pieniądze, zwrócimy je automatycznie.” + link do mapy,
   - held po 60 s → „Wciąż czekamy na potwierdzenie od Stripe” + „Sprawdź ponownie” (nie obiecuj biletu),
   - NIGDY nie pokazuj biletu tylko dlatego, że jesteśmy na /payment/success (Z30).
4. /payment/cancel?reservationId=… (karta C) — „Płatność przerwana”:
   - held i ważna → licznik (ten sam co na ekranie rezerwacji, zegar serwera) + „Zapłać ponownie” (ten sam checkout — Kamil zwraca ten sam url),
   - expired → „Rezerwacja wygasła, miejsce wróciło do puli” + link do mapy,
   - paid (np. zapłacił w drugiej karcie) → bilet.
5. Wspólne: hook usePollReservation / komponent statusu w src/components/payment/, aria-live dla zmian statusu, responsywnie, fetch z no-store, apiFetch z src/components/reservation/api.ts (dopisz obsługę nagłówka Retry-After).
6. Ticket: „Zapłacono 89,00 zł · <data płatności>” zamiast „Kupiono”.

DEFINICJA "GOTOWE": z prawdziwym Stripe (sk_test_ + stripe listen): mapa → formularz z ceną → „Zapłać 89,00 zł” → strona Stripe → 4242… → /payment/success → po kilku sekundach bilet; „Wróć” na stronie Stripe → /payment/cancel → „Zapłać ponownie” → ta sama strona Stripe; 4000 0000 0000 0002 → odmowa na stronie Stripe, rezerwacja dalej held; 4000 0025 0000 3155 → okno 3D Secure → bilet; wejście na /payment/success?reservationId=<nieopłacona> → brak biletu; podwójny klik „Zapłać” → jedno żądanie. npm run build, lint, test zielone.
Zanim zaczniesz, pokaż krótki plan. Małe commity, na koniec opis PR.
```

---

## Prompt M3 — Mateusz: spięcie, Stripe na Vercelu, atak, demo

```
Jestem liderem zespołu w projekcie PAS S01 (system rezerwacji biletów na POCIĄG „Konduktor”, Next.js 15 + MongoDB Atlas + Stripe, wdrożenie na Vercel). Karty Etapu II są w master. Spinam całość, wdrażam i sam atakuję system przed demem. Przeczytaj CONTRACT.md w całości, zwłaszcza §0, §3, §4, §7 (Z22–Z35), oraz DEPLOY.md i DEMO.md.
Pracuj na branchu feature/e2-attack z aktualnego master.

1. scripts/attack.mjs — aktualizacja na Etap II (dalej czysty Node 20+, bez zależności):
   - kryteria CEO dla Etapu I (PAS Kryteria): A1, A2 (miejsce znika z takenSeats ≤ 15 s po expiresAt — z --slow), B1 (identyczny POST 2× po kolei i równolegle → ta sama rezerwacja), B2 (20 równoczesnych rezerwacji jednego miejsca od różnych klientów → dokładnie 1×2xx, reszta 4xx), B3, B4 (z --slow), B5 (100 rezerwacji różnych miejsc w 10 s → 429 + Retry-After; nagłówek x-forwarded-for innego „klienta” nie może obejść limitu na Vercelu — sprawdź i opisz), C1–C4 przeniesione na checkout (2× checkout → ten sam url, checkout nieistniejącej / abc → 404, checkout po czasie → 410, opłacona → 409),
   - limit ruchu psuje własne scenariusze: rozłóż je w czasie (czekaj na Retry-After) albo licz 429 jako oczekiwany wynik tam, gdzie to zgodne z kryterium; nigdy nie licz 5xx jako sukcesu,
   - webhook: POST bez podpisu → 400; ze złym podpisem → 400; z flagą --webhook-secret <whsec> (tylko lokalnie, NIGDY na produkcji) podpisane zdarzenia przez node:crypto (nagłówek t=…,v1=HMAC-SHA256): checkout.session.completed z nieistniejącą rezerwacją → 200 i nic; ten sam event 2× → 200 i jeden kod,
   - /payment/success?reservationId=<nieopłacona> → strona nie zawiera kodu biletu (Z30),
   - zamiast dawnego /purchase: /purchase na held → 402,
   - wynik jak dotąd: PASS/FAIL, exit code, UWAGA dla znanych zachowań.
2. scripts/reset.ts: czyści także stripe_events i rate_limits (deleteMany, nie drop) i dalej wymaga --yes / --prod.
3. Wdrożenie (instrukcje do DEPLOY.md + zrób je):
   - Vercel env: STRIPE_SECRET_KEY (sk_test_), STRIPE_WEBHOOK_SECRET, APP_URL=https://<adres>.vercel.app, RATE_LIMIT_MAX=40, RATE_LIMIT_WINDOW_SECONDS=10; redeploy,
   - Stripe Dashboard (tryb testowy) → Developers → Webhooks → Add endpoint https://<adres>.vercel.app/api/webhooks/stripe, zdarzenia checkout.session.completed i checkout.session.async_payment_succeeded; jego whsec_ do Vercela,
   - nauczyciel w zespole Stripe z rolą tylko do odczytu,
   - po wdrożeniu: npm run seed (ceny) i npm run reset -- --yes --prod.
4. Test end-to-end na Vercelu z kartami: 4242… (bilet), 4000 0000 0000 0002 (odmowa, rezerwacja held), 4000 0025 0000 3155 (3D Secure → bilet), przerwanie i ponowna płatność, płatność po wygaśnięciu (otwórz Stripe, odczekaj > 2 min, zapłać → brak biletu, zwrot widoczny w Stripe Dashboard). Wyniki do DEPLOY.md.
5. DEMO.md: nowy scenariusz (rezerwacja z ceną → Stripe → bilet; przerwanie → ponowna płatność; odmowa karty; spóźniona płatność → zwrot), tabela zagrożeń Z22–Z35 po jednym zdaniu, odpowiedzi na pytania CEO (dlaczego webhook, a nie strona powrotu; co przy podwójnej płatności; gdzie są klucze; skąd wiecie, że kwoty nie da się podmienić).
6. Ściąga dla Kamila (osobny dokument) — zaktualizuję ją sam po tym prompcie.

DEFINICJA "GOTOWE": attack.mjs na Vercelu = same PASS (z --slow też); test kart z punktu 4 przeszedł; DEPLOY.md i DEMO.md gotowe.
Zanim zaczniesz, pokaż krótki plan. Błąd w cudzym pliku → NIE poprawiaj, opisz: endpoint, wejście, oczekiwany i faktyczny wynik, plik.
```
