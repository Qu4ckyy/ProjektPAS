# PROMPTY.md — prompty dla agentów (Etap III, punkty lojalnościowe)

Prompty wcześniejszych etapów: [PROMPTY-ETAP-1.md](PROMPTY-ETAP-1.md), [PROMPTY-ETAP-2.md](PROMPTY-ETAP-2.md).

Kolejność:
1. **Mateusz — M1 (szkielet Etapu III + konta Voucherify i Resend)** — wchodzi pierwszy.
2. Równolegle: **Kamil — K3** (karta B: płatność punktami), **Eryk — E3** (karta A: konto punktowe), **Mateusz — M2** (karta C: mail + frontend punktów).
3. **Mateusz — M3** (spięcie, Vercel, atak, demo) — po merge K3, E3 i M2.

Każdy pracuje na świeżym `master` (`git checkout master && git pull`). W `.env.local` każdy ma to, co w Etapie II, plus `LOYALTY_PROVIDER=memory` i `MAIL_PROVIDER=log` — wtedy punkty żyją w pamięci serwera, a mail ląduje w konsoli. Prawdziwe Voucherify i Resend włączacie na krótko do sprawdzenia swojej karty (klucze od lidera): **sandbox Voucherify ma 100 wywołań na godzinę na cały zespół**, więc nie odświeżajcie strony w pętli i nie puszczajcie testów na prawdziwym API. Kluczy nie wklejamy do czatu ani do repo.

---

## Prompt M1 — Mateusz: szkielet Etapu III

```
Jestem liderem 3-osobowego zespołu w projekcie PAS S01: system rezerwacji biletów na POCIĄG „Konduktor” (Next.js 15 App Router + TypeScript + MongoDB + Stripe). Etapy I i II działają na produkcji. Etap III: program lojalnościowy w Voucherify (punkty: 1000 na start, 10 pkt za każdy pełny złoty zapłacony kartą, punktami do połowy ceny, 1 pkt = 1 grosz) i mail z biletem przez Resend. Oceniana jest NIEZAWODNOŚĆ.
Przeczytaj CONTRACT.md w całości — to źródło prawdy, szczególnie §0a (D12–D22), §2, §3 „Punkty — szczegóły”, §6, §7 Z36–Z54. Nie zmieniaj go bez pytania mnie.
Pracuj na branchu feature/e3-skeleton z aktualnego master.

ZADANIE: szkielet Etapu III, żeby Kamil (karta B), Eryk (karta A) i ja (karta C + frontend) mogli od razu pracować równolegle na zaślepkach. W szkielecie wolno mi ruszyć pliki wszystkich (§6). Bez nowych zależności w package.json (Voucherify i Resend przez fetch).

1. src/lib/types.ts: pola Reservation z §2 (pointsUsed, cardAmount, pointsEarned, loyalty, ticketEmail, typ LoyaltyStep), LoyaltyMember, odpowiedzi API z §3 (ReservationResponse i TicketResponse z pointsUsed, cardAmount, pointsEarned; CheckoutResponse { url, pointsUsed, cardAmount }; LoyaltyResponse { email, points }; ReservationPointsResponse { balance, maxPoints, pointsUsed, locked }), nowe ErrorCode z §4 i dodatkowe pola odmów punktowych.
2. src/lib/points.ts (mój): WELCOME_POINTS, POINTS_PER_ZLOTY, maxPointsFor, pointsEarnedFor, formatPoints — dokładnie jak §3, z testem tests/points.test.ts (8900 → max 4450; 7900 → 790; 4450 → 440; 99 → 0; 0 → 0).
3. src/lib/errors.ts: helper do odmów punktowych z dodatkowym polem (np. jsonError z opcjonalnym extra).
4. Zaślepki z komentarzem `// STUB — implementuje <Imię>`, działające bez kluczy:
   - [Eryk] src/lib/voucherify.ts: interfejs LoyaltyClient, LoyaltyUnavailableError, getLoyaltyClient() z implementacją "memory" (Map w globalThis: e-mail → { memberId, balance, transakcje }) — wystarczająco dobrą do pracy innych; implementacja "voucherify" rzuca na razie LoyaltyUnavailableError. Odmowa "memory"/"log" przy VERCEL_ENV === "production" (D21).
   - [Eryk] src/lib/loyalty.ts: wszystkie funkcje z §6 — prosta wersja na kliencie (getPoints → 1000 dla nowego e-maila, applyPoints → adjustBalance, settleLoyalty / earnForPurchase / runLoyaltyRetries → nic).
   - [Eryk] GET /api/loyalty (walidacja e-maila, getPoints) i GET /api/cron/settle (sprawdza Authorization: Bearer CRON_SECRET → 401, potem runLoyaltyRetries + retryTicketEmails).
   - [Eryk] reservations.ts: claimPointsSpend / finishPointsSpend (prosta poprawna wersja), saveCheckoutSession z nową sygnaturą, GET rezerwacji i biletu z pointsUsed/cardAmount/pointsEarned (brak pól → 0 / amount / null).
   - [Eryk] payments.ts: acceptPayment porównuje kwotę z cardAmount ?? amount i zapisuje pointsEarned; po przyjęciu after(() => Promise.allSettled([earnForPurchase(id), sendTicketEmail(id)])).
   - [Kamil] src/lib/spend.ts: spendPointsForCheckout — zaślepka: claimPointsSpend → applyPoints(−points) → finishPointsSpend("done"). checkout.ts: czyta body { points } (prosta walidacja), points > 0 → spend, sesja Stripe na cardAmount, odpowiedź { url, pointsUsed, cardAmount }. GET /api/reservations/[id]/points → { balance: getPoints(email), maxPoints, pointsUsed, locked }. rateLimit: kubełek "loyalty".
   - [Mateusz] src/lib/mail.ts: sendTicketEmail z providerem "log" (console.log tematu i tekstu) i retryTicketEmails → 0.
   - [Mateusz] HoldView: pole „Użyj punktów” (liczba, bez podpowiedzi) wysyłane w body checkoutu; bilet pokazuje pointsUsed i pointsEarned w jednej linii.
   - Wszystkie nowe route'y: export const dynamic = "force-dynamic", withErrorHandling, params jako Promise.
5. src/lib/db.ts: indeksy z §2 [E3] (reservations) i ensureIndexes dla loyalty_members (tylko _id — nic nie dodawaj).
6. vercel.json: cron { "path": "/api/cron/settle", "schedule": "0 4 * * *" } (Hobby: raz dziennie).
7. .env.example: zmienne [E3] z §1 z komentarzami. tests/setup-env.ts: LOYALTY_PROVIDER=memory, MAIL_PROVIDER=log. README: sekcja „Punkty i maile lokalnie” (memory/log, kiedy włączyć prawdziwe usługi, limit 100/h, adresy delivered@resend.dev i bounced@resend.dev).
8. Istniejące testy zostają zielone; nie kasuj scenariuszy Etapów I–II.

DEFINICJA "GOTOWE": npm run build, lint, test zielone; przeklikanie bez kluczy Voucherify/Resend: GET /api/loyalty?email=jan@example.com → { email, points: 1000 }; rezerwacja → „Użyj punktów” 1000 → „Zapłać” → strona Stripe na 79,00 zł → 4242 → bilet z „punktami 1000 pkt” i „zebrane punkty: 790”; w konsoli serwera log maila; GET /api/loyalty dla tego e-maila → 790 (memory: 1000 − 1000 + 790).
Zanim zaczniesz, pokaż krótki plan. Małe commity (Conventional Commits), na koniec opis PR z listą plików i właścicieli.

POZA KODEM (zrób sam w przeglądarce, agent tylko przypomina):
- Voucherify: konto (60 dni za darmo), projekt Sandbox, kampania lojalnościowa „Konduktor Punkty” bez reguł naliczania i bez wygasania punktów (punkty dodaje nasz kod), z Project settings → Application keys: API URL, Application ID, Secret Key; id kampanii (camp_…). Klucze zespołowi prywatnie.
- Resend: konto na mój e-mail, API key z uprawnieniem „Sending access”. Bez domeny wysyła tylko na mój adres i adresy testowe.
- Vercel: CRON_SECRET (losowy, np. openssl rand -hex 32).
```

---

## Prompt K3 — Kamil: karta B (płatność punktami)

```
Pracuję w 3-osobowym zespole nad projektem PAS S01: system rezerwacji biletów na POCIĄG „Konduktor” (Next.js 15 App Router + TypeScript + MongoDB + Stripe). Etap III: program lojalnościowy w Voucherify. Moja karta B: klient płaci częścią ceny punktami (do połowy ceny, 1 pkt = 1 grosz), resztę kartą przez Stripe. Oceniana jest NIEZAWODNOŚĆ — CEO atakuje API.
Przeczytaj CONTRACT.md w całości (szczególnie §0a D15, D16, D20, D22, §2 pola lojalnościowe, §3 „Punkty — szczegóły” — kolejność checkoutu krok po kroku i „Pewność operacji”, §4, §6, §7 Z36–Z38, Z43–Z45, Z53). Nie zmieniaj kontraktu ani plików innych osób (§6) — jeśli trzeba, zatrzymaj się i napisz mi, co i dlaczego. Nie dodawaj zależności.
Pracuj na branchu feature/e3-spend z aktualnego master. Szkielet ma zaślepki; funkcje Eryka (loyalty.ts, claimPointsSpend, finishPointsSpend, saveCheckoutSession) mają prostą poprawną wersję w pamięci (LOYALTY_PROVIDER=memory).

MOJA KARTA: B — płatność punktami. Pliki: src/lib/checkout.ts, src/lib/spend.ts, src/app/api/reservations/[id]/checkout/**, src/app/api/reservations/[id]/points/**, src/lib/rateLimit.ts (kubełek "loyalty").

1. Walidacja body checkoutu (§3, D22, Z37, Z53): puste/{} → points 0; nie-obiekt albo > 10 kB → 400; points musi spełniać Number.isSafeInteger i ≥ 0 (string "100", 1.5, −1, NaN, null, {} → 400 VALIDATION_ERROR); points > maxPointsFor(amount) z src/lib/points.ts → 400 POINTS_OVER_LIMIT z polem maxPoints — bez wołania Voucherify. Inne pola body (amount!) ignoruj. Uwaga: limit ruchu nadal PRZED walidacją.
2. Checkout (D16): rezerwacja ma payment → points brak albo równe pointsUsed → ten sam url (bez Stripe, bez Voucherify); inne → 409 POINTS_LOCKED z polem pointsUsed. points 0 → jak w Etapie II, ZERO wywołań Voucherify, saveCheckoutSession z pointsUsed 0 i cardAmount = amount.
3. src/lib/spend.ts — spendPointsForCheckout (kroki 4–7 z §3):
   - claimPointsSpend (Eryk): przegrany z tą samą liczbą punktów (SPEND_IN_PROGRESS) czeka do 8 s (odpytuje rezerwację co ~300 ms), aż payment.url się pojawi, i zwraca ten sam url; inna liczba → POINTS_LOCKED,
   - acquireSpendLock(email) (Eryk) → false: finishPointsSpend("retry") i 409 LOYALTY_BUSY,
   - getFreshBalance(email) → saldo < points: finishPointsSpend("failed"), 409 INSUFFICIENT_POINTS z polem balance,
   - applyPoints(email, −points, "spend-<id>", "Bilet <id>") → "done" → finishPointsSpend("done"); "retry" albo LoyaltyUnavailableError → finishPointsSpend("retry"), 503 LOYALTY_UNAVAILABLE,
   - zawsze releaseSpendLock w finally,
   - NIGDY nie twórz sesji Stripe ze zniżką bez loyalty.spend.status "done" (Z44).
4. Sesja Stripe: unit_amount = cardAmount, metadata { reservationId, eventId, seatId, pointsUsed }, opis z „punkty: −10,00 zł” gdy pointsUsed > 0 (formatPrice). Parametry dalej DETERMINISTYCZNE (idempotency key checkout-<id> bez zmian — po D16 liczba punktów w sesji już się nie zmieni). Błąd Stripe po pobraniu punktów → 503 PAYMENT_UNAVAILABLE, punkty zostają (spend done), kolejne „Zapłać” tworzy sesję bez ponownego pobrania.
5. Odpowiedź checkoutu: 200 { url, pointsUsed, cardAmount }.
6. GET /api/reservations/[id]/points: rateLimit(req, "loyalty"); zły id → 404; e-mail z rezerwacji (nigdy z URL); balance = getPoints(email) (Eryk — robi też zwroty zaległych punktów), maxPoints = min(balance, maxPointsFor(amount)), locked = rezerwacja ma payment (wtedy maxPoints = pointsUsed); LoyaltyUnavailableError → 503 LOYALTY_UNAVAILABLE. Nie zwracaj e-maila.
7. TESTY (nowy plik tests/spend.test.ts, LOYALTY_PROVIDER=memory, Stripe zmockowany jak w tests/checkout.test.ts; nie zmieniaj plików Eryka ani helpers.ts):
   - walidacja: każdy zły points z punktu 1 → 400; 4451 przy cenie 8900 → POINTS_OVER_LIMIT; { amount: 100 } → sesja na pełną kwotę z bazy;
   - 1000 pkt: sesja na 7900, saldo w memory 0, pointsUsed 1000;
   - 10 równoległych checkoutów z points 1000 → jeden url, saldo zeszło dokładnie raz;
   - zmiana punktów po pierwszym checkoucie → 409 POINTS_LOCKED, sesja ta sama;
   - za mało punktów → 409 INSUFFICIENT_POINTS, rezerwacja bez payment, spend failed, kolejny checkout bez punktów działa;
   - dwie rezerwacje tego samego e-maila, równolegle po 1000 pkt (saldo 1000) → dokładnie jedna dostaje sesję ze zniżką, druga 409 (LOYALTY_BUSY albo INSUFFICIENT_POINTS), saldo nigdy < 0 (Z36);
   - LoyaltyUnavailableError → 503, brak sesji Stripe, spend retry; z points 0 przy niedziałającym Voucherify → 200 (Z43);
   - błąd Stripe po pobraniu punktów → 503; ponowny checkout → sesja bez drugiego pobrania.

DEFINICJA "GOTOWE": npm test, lint, build zielone; lokalnie (memory + prawdziwy sk_test_): rezerwacja → POST checkout { "points": 1000 } → strona Stripe na 79,00 zł z opisem punktów; drugi POST z 1000 → ten sam url; z 500 → 409 POINTS_LOCKED; GET /api/reservations/<id>/points → locked true. Na koniec jedna próba z prawdziwym Voucherify (LOYALTY_PROVIDER=voucherify, klucze od lidera) — sprawdź w panelu, że z karty zeszło 1000 pkt.
Zanim zaczniesz, pokaż krótki plan. Małe commity, na koniec opis PR z listą zagrożeń z §7, które obsłużyłem, i jak to przetestować.
```

---

## Prompt E3 — Eryk: karta A (konto punktowe)

```
Pracuję w 3-osobowym zespole nad projektem PAS S01: system rezerwacji biletów na POCIĄG „Konduktor” (Next.js 15 App Router + TypeScript + MongoDB + Stripe). Etap III: program lojalnościowy w Voucherify. Moja karta A: konto punktowe klienta — saldo, 1000 punktów powitalnych, punkty za zakup, zwrot punktów za nieopłacone rezerwacje. Źródłem prawdy o saldzie jest Voucherify (sandbox: 100 wywołań na godzinę!). Oceniana jest NIEZAWODNOŚĆ.
Przeczytaj CONTRACT.md w całości (szczególnie §0a D12–D14, D17, D18, D20, D21, §2 pola lojalnościowe i loyalty_members, §3 „Punkty — szczegóły”, §6, §7 Z39–Z44, Z49, Z51, Z52, Z54). Nie zmieniaj kontraktu ani plików innych osób — jeśli trzeba, zatrzymaj się i napisz mi. Nie dodawaj zależności (fetch, bez SDK).
Pracuj na branchu feature/e3-loyalty z aktualnego master. Szkielet ma zaślepki i provider "memory".

MOJA KARTA: A — konto punktowe. Pliki: src/lib/voucherify.ts, src/lib/loyalty.ts, src/app/api/loyalty/**, src/app/api/cron/**, plus moje reservations.ts, payments.ts, tickets i tests/**.

1. src/lib/voucherify.ts — klient REST API v1 (jak w PDF etapu), nagłówki X-App-Id / X-App-Token, timeout 5 s (AbortSignal.timeout), bez logowania kluczy:
   - findMember(email): GET /v1/loyalties/{campaignId}/members?customer=<email> → { memberId: code, balance: loyalty_card.balance } albo null,
   - createMember(email): POST /v1/loyalties/{campaignId}/members z customer { source_id: email, email },
   - getBalance(memberId), adjustBalance(memberId, points, { reason, sourceId }): POST /v1/loyalties/{campaignId}/members/{memberId}/balance { points, reason, source_id } → nowe saldo,
   - hasTransaction(memberId, sourceId): GET …/members/{memberId}/transactions — szukaj source_id (albo reason, jeśli source_id nie wraca),
   - 429 → LoyaltyUnavailableError z retryAfterSeconds z Retry-After / X-Rate-Limit-Retry; zapamiętaj blokadę do tej chwili (§3 „Budżet wywołań”) i do jej końca nie wołaj Voucherify wcale; 5xx/sieć → LoyaltyUnavailableError; timeout po wysłaniu POST → uncertain: true,
   - NAJPIERW w sandboxie sprawdź na 2–3 ręcznych wywołaniach (curl, klucze w zmiennych, nie w repo): kształt odpowiedzi, czy ujemny points poniżej salda jest odrzucany, czy drugi createMember dla tego samego source_id daje błąd czy drugą kartę, czy transakcje zwracają source_id. Wnioski wpisz do opisu PR — od nich zależy „Pewność operacji”.
   - provider "memory" z szkieletu zostaje do testów; odmowa memory przy VERCEL_ENV=production (D21).
2. src/lib/loyalty.ts — wszystkie funkcje z §6:
   - normalizeEmail (D13) — użyj go też w createReservation (e-mail zapisany po normalizacji już jest — sprawdź),
   - ensureMember (D14, Z51): atomowe absent/brak → creating w loyalty_members; zwycięzca: findMember (karta z panelu → bez powitalnych) albo createMember + applyPoints(+1000, "welcome-<email>"); welcome pending → done; przegrany czeka do kilku sekund na ready,
   - getPoints (D20): settleLoyalty({ email }) → pamięć podręczna 30 s / absent 10 min / jedno findMember; 429 lub niedostępność → ostatnie znane saldo, a bez niego LoyaltyUnavailableError,
   - getFreshBalance: zawsze z Voucherify (1000 dla e-maila bez karty — wtedy NIE zakładaj karty, to zrobi applyPoints przez ensureMember),
   - applyPoints z „Pewnością operacji”: uncertain → hasTransaction → done/retry; aktualizuj balance i balanceAt,
   - acquireSpendLock / releaseSpendLock (spendLockUntil, 15 s, atomowo),
   - settleLoyalty (D17, Z39, Z40): jedno findOneAndUpdate zamyka rezerwację (status expired, active false, loyalty.refund pending) tylko gdy spend done, nie paid, a active false albo expiresAt < teraz − 30 s; potem +pointsUsed z "refund-<id>"; kroki pending starsze niż 2 min → najpierw hasTransaction (Z54),
   - earnForPurchase (D18, Z41): zajęcie earn (pending/retry → pending), +pointsEarned z "earn-<id>" przez ensureMember; pointsEarned 0 → done bez wołania Voucherify,
   - runLoyaltyRetries: zaległe refund i earn (limit np. 20 na przebieg, żeby nie zjeść 100/h).
3. GET /api/loyalty: rateLimit(req, "loyalty") → walidacja e-maila jak w rezerwacji → 200 { email (znormalizowany), points }; LoyaltyUnavailableError → 503 LOYALTY_UNAVAILABLE. Nic poza tymi polami (Z49).
4. GET /api/cron/settle: Authorization: Bearer <CRON_SECRET> (porównanie stałoczasowe; brak sekretu w env → 401 zawsze) → runLoyaltyRetries + retryTicketEmails (Mateusz) → 200 { refunded, earned, emails }.
5. reservations.ts / payments.ts:
   - claimPointsSpend / finishPointsSpend / saveCheckoutSession wg §6 (atomowo; testy wyścigów),
   - GET /api/reservations/:id: po syncCheckoutSession — settleLoyalty({ reservationId }), dla paid z earn retry/stary pending → after(earnForPurchase), ticketEmail retry → after(sendTicketEmail); odpowiedź z pointsUsed, cardAmount, pointsEarned (null przed opłaceniem),
   - acceptPayment: kwota = cardAmount ?? amount, w tym samym przejściu pointsEarned i loyalty.earn pending; potem after(earnForPurchase + sendTicketEmail) — dla webhooka i dla sync z GET,
   - zwrot pieniędzy za rezerwację z spend done, która nie jest paid → też settleLoyalty({ reservationId }) (Z40),
   - GET /api/tickets/:code z pointsUsed, cardAmount, pointsEarned.
6. TESTY (vitest, pociag_test, LOYALTY_PROVIDER=memory, Voucherify i Stripe zmockowane; dla voucherify.ts zmockuj fetch):
   - GET /api/loyalty: nowy e-mail → 1000 bez zakładania karty; JAN@Example.com = jan@example.com; zły e-mail → 400; Voucherify 429 → saldo z pamięci, bez niej 503;
   - powitalne 1000 dokładnie raz przy 5 równoległych pierwszych operacjach (Z51);
   - zakup 8900 bez punktów → +890 (nowy klient: 1000 + 890 = 1890); z 1000 pkt → 7900 kartą, +790, saldo 790;
   - webhook 2× i webhook + GET → punkty naliczone raz (Z41);
   - rezerwacja z spend done wygasa → GET rezerwacji albo GET /api/loyalty oddaje punkty raz; spóźniona płatność z punktami → zwrot pieniędzy + zwrot punktów, brak biletu (Z40);
   - wyścig: settleLoyalty vs webhook w chwili wygaśnięcia (5×) → albo paid i punkty zostają, albo expired, zwrot pieniędzy i punktów — nigdy oba;
   - applyPoints z uncertain: transakcja jest → done bez drugiego wywołania; nie ma → retry;
   - Voucherify niedostępny przy naliczeniu → bilet jest, earn retry, potem runLoyaltyRetries dolicza;
   - cron bez sekretu / ze złym → 401;
   - wszystkie dotychczasowe testy zielone.

DEFINICJA "GOTOWE": npm test, lint, build zielone; z prawdziwym Voucherify (krótko, liczcie wywołania): GET /api/loyalty dla nowego e-maila → 1000 i brak karty w panelu; zakup przez Stripe (`stripe listen`) → w panelu karta z 1000 + 890; drugi GET w ciągu 30 s nie woła Voucherify.
Zanim zaczniesz, pokaż krótki plan. Małe commity, na koniec opis PR z listą zagrożeń z §7, które obsłużyłem, wnioskami z ręcznych wywołań sandboxa i liczbą wywołań Voucherify na jeden zakup.
```

---

## Prompt M2 — Mateusz: karta C (mail) + frontend punktów

```
Pracuję w 3-osobowym zespole nad projektem PAS S01: system rezerwacji biletów na POCIĄG „Konduktor” (Next.js 15 App Router + TypeScript + Tailwind). Jestem liderem. Etap III: punkty lojalnościowe (Voucherify) i mail z biletem (Resend). Oceniana jest NIEZAWODNOŚĆ.
Przeczytaj CONTRACT.md w całości (szczególnie §0a D16, D19, D21, §3 „Mail z biletem” i „Punkty — szczegóły”, §4, §5, §7 Z38, Z45–Z48). Nie zmieniaj plików innych osób (§6).
Pracuj na branchu feature/e3-mail-frontend z aktualnego master. Backend może być jeszcze zaślepką (memory/log) — pracuj na kształtach z kontraktu.

MOJE ZADANIE: karta C (mail z biletem) i wszystko, co klient widzi przy punktach. Pliki: src/lib/mail.ts, src/components/**, src/app/reserve/**, src/app/reservations/**, src/app/payment/**, tests/mail.test.ts.

1. src/lib/mail.ts (D19, Z46–Z48):
   - sendTicketEmail(reservationId): atomowe zajęcie ticketEmail (brak/retry → sending, attempts + 1; sending starsze niż 2 min też można przejąć — Resend i tak odrzuci duplikat po Idempotency-Key), tylko dla paid; fetch POST https://api.resend.com/emails z Authorization: Bearer RESEND_API_KEY, Idempotency-Key: ticket-<reservationId>, from MAIL_FROM, to e-mail z rezerwacji, subject „Bilet <kod> — <pociąg> <relacja>”, html + text; timeout 10 s,
   - wynik: 2xx → sent + resendId; 409 invalid_idempotent_request / concurrent → traktuj jak sent (już wysłane); 429/5xx/sieć → retry (najwyżej 5 prób, potem failed); inne 4xx (403 adres spoza testowych, 422) → failed. Nigdy nie rzuca. Brak klucza → failed i console.error,
   - treść jak §3: kod, kurs, odjazd (Europe/Warsaw, formatDate/formatTime), wagon i miejsce (seatLabel), pasażer, „Zapłacono kartą: 79,00 zł”, „Zapłacono punktami: 1000 pkt (10,00 zł)” (tylko gdy > 0), „Zebrane punkty: 790”, link APP_URL/reservations/<kod>; wszystkie dane klienta przez escape HTML (Z48); prosty HTML z inline CSS, bez obrazków,
   - provider "log": console.log tematu i tekstu, status sent (resendId "log"),
   - retryTicketEmails(): zaległe retry i stare sending (limit 20) — woła cron Eryka.
2. /reserve (karta A — frontend): po poprawnym e-mailu (ta sama walidacja co pole) z opóźnieniem 500 ms GET /api/loyalty → „Masz 1000 pkt (10,00 zł). Możesz nimi zapłacić do połowy ceny.”; jedno żądanie naraz (AbortController), 503/429 → nic nie pokazuj (formularz działa bez punktów), nigdy nie blokuj rezerwacji.
3. /reservations/<id> (held) (karta B — frontend):
   - GET /api/reservations/<id>/points → pole „Użyj punktów” (liczba, krok 1, min 0, max maxPoints), podpowiedź „Najwięcej: 1000 pkt (masz 1000 pkt)”, przycisk „Użyj wszystkich”; cena i przycisk zmieniają się od razu: „Zapłać 79,00 zł” (amount − punkty, formatPrice), obok „w tym 1000 pkt = 10,00 zł”,
   - walidacja na kliencie jak serwer (liczba całkowita, 0…maxPoints), ale serwer i tak decyduje: 400 POINTS_OVER_LIMIT / 409 INSUFFICIENT_POINTS → komunikat i korekta pola do maxPoints/balance z odpowiedzi; 409 POINTS_LOCKED → pole zablokowane na pointsUsed; 409 LOYALTY_BUSY i 503 LOYALTY_UNAVAILABLE → komunikat + „Zapłać bez punktów” (ustawia 0),
   - locked (był już checkout) → pole tylko do odczytu z pointsUsed; „Zapłać ponownie” na /payment/cancel wysyła te same punkty,
   - points endpoint niedostępny → pole ukryte, płatność bez punktów działa jak w Etapie II,
   - podwójny klik dalej blokowany (Z38 — jedno żądanie).
4. /payment/success i bilet (karta C — frontend): podsumowanie „Kartą 79,00 zł · punktami 1000 pkt (10,00 zł) · zebrane punkty: 790”; bez punktów: „Kartą 89,00 zł · zebrane punkty: 890”; pod spodem „Wysyłamy bilet na Twój e-mail.” (nie „wysłaliśmy” — mail mógł nie dojść; strona nie zna e-maila i go nie wyświetla).
5. tests/mail.test.ts: fetch zmockowany — sukces → sent i Idempotency-Key ticket-<id>; 2 równoległe sendTicketEmail → jedno wywołanie Resend; 429 → retry, po 5 → failed; 403 → failed bez ponowień; imię `<img src=x onerror=alert(1)>` w HTML jako tekst; brak punktów → brak linii punktów; mail tylko dla paid.

DEFINICJA "GOTOWE": lokalnie memory/log: formularz pokazuje saldo, licznik z polem punktów, „Zapłać 79,00 zł” → Stripe na 79,00 zł → bilet z podsumowaniem, mail w konsoli raz (także po odświeżeniu strony sukcesu i powtórce webhooka z `stripe events resend`). Raz z prawdziwym Resend na delivered+test@resend.dev i bounced+test@resend.dev (Resend → Emails: delivered / bounced; bilet w obu przypadkach działa). npm run build, lint, test zielone.
Zanim zaczniesz, pokaż krótki plan. Małe commity, na koniec opis PR.
```

---

## Prompt M3 — Mateusz: spięcie, Vercel, atak, demo

```
Jestem liderem zespołu w projekcie PAS S01 (system rezerwacji biletów na POCIĄG „Konduktor”, Next.js 15 + MongoDB Atlas + Stripe + Voucherify + Resend, wdrożenie na Vercel). Karty Etapu III są w master. Spinam całość, wdrażam i sam atakuję system przed demem. Przeczytaj CONTRACT.md w całości, zwłaszcza §0a, §3, §4, §7 (Z36–Z54), oraz DEPLOY.md i DEMO.md.
Pracuj na branchu feature/e3-attack z aktualnego master.

1. scripts/attack.mjs — Etap III (dalej czysty Node 20+, bez zależności), wszystkie dotychczasowe kryteria (I: A1–C4, II: II.A1–II.C3) bez zmian plus:
   - GET /api/loyalty: brak/zły e-mail → 400; nowy e-mail → { email, points: 1000 }; wielkie litery → ten sam e-mail w odpowiedzi; nic poza email i points; nigdy 5xx,
   - checkout z points: "100", 1.5, −1, null, {} → 400; ponad połowę → 400 POINTS_OVER_LIMIT; więcej niż saldo → 409; { amount: 100 } → sesja na kwotę z bazy (II.A1); 5 równoległych z tymi samymi punktami → jeden url i saldo zeszło raz; inna liczba po pierwszym → 409 POINTS_LOCKED,
   - GET rezerwacji ma pointsUsed, cardAmount i pointsEarned (null przed opłaceniem),
   - z --webhook-secret (tylko lokalnie): opłacenie rezerwacji z punktami → pointsEarned = floor(cardAmount / 100) × 10; powtórka zdarzenia nie zmienia pointsEarned ani salda; liczbę maili (provider log) sprawdzam ręcznie w logu serwera — atak tylko wypisuje UWAGA z przypomnieniem,
   - BUDŻET: na produkcji cała część punktowa ≤ 25 wywołań Voucherify na przebieg (limit 100/h na projekt!) — flaga --skip-loyalty, e-maile testowe delivered+atk-<czas>-<n>@resend.dev (każdy przebieg nowi klienci), wypisz na końcu szacowaną liczbę wywołań.
2. scripts/reset.ts: czyści także loyalty_members (deleteMany) i ostrzega, że salda w Voucherify zostają (nowe e-maile w ataku to omijają).
3. Wdrożenie (instrukcje do DEPLOY.md + zrób je): Vercel env z §1 [E3] (LOYALTY_PROVIDER=voucherify, MAIL_PROVIDER=resend, klucze, CRON_SECRET), redeploy, cron widoczny w Settings → Cron Jobs; sprawdź /api/cron/settle bez sekretu → 401.
4. Test end-to-end na Vercelu (robię ręcznie): nowy klient delivered+demo@resend.dev — saldo 1000 → rezerwacja 89 zł, 1000 pkt → Stripe 79,00 zł → 4242 → bilet z podsumowaniem → mail w Resend (delivered) → saldo 790 w aplikacji i w panelu Voucherify; bez punktów → +890; spóźniona płatność z punktami → zwrot w Stripe i punkty wracają; bounced+demo@resend.dev → bilet jest, mail bounced. Stripe CLI na produkcji: `stripe trigger checkout.session.completed` → 200, nic się nie zmienia (II.B2). Wyniki do DEPLOY.md.
5. DEMO.md: nowy scenariusz Etapu III (saldo → płatność punktami → mail → saldo po zakupie), tabela Z36–Z54 po jednym zdaniu, pytania CEO (dlaczego punkty schodzą przy „Zapłać”; co gdy klient nie zapłaci; co gdy Voucherify padnie; skąd pewność, że mail nie przyjdzie dwa razy; limit 100/h).
6. Ściąga dla Kamila — zaktualizuję ją sam po tym prompcie.

DEFINICJA "GOTOWE": attack.mjs na Vercelu = same PASS (z --slow też) i ≤ 25 wywołań Voucherify; test z punktu 4 przeszedł; DEPLOY.md i DEMO.md gotowe.
Zanim zaczniesz, pokaż krótki plan. Błąd w cudzym pliku → NIE poprawiaj, opisz: endpoint, wejście, oczekiwany i faktyczny wynik, plik.
```
