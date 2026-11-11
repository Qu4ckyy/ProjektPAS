# DEPLOY.md — wdrożenie Etapu III (Vercel + MongoDB Atlas + Stripe + Voucherify + Resend)

Checklista lidera. Odhaczaj po kolei. Atlas, Vercel i Stripe są skonfigurowane z Etapów I–II — w Etapie III dochodzą punkty (Voucherify), mail z biletem (Resend) i dzienny cron.

## 1. Kod

Po każdym merge na świeżym `master`:

```bash
npm ci
npm run build
npm run lint
npm test          # MONGODB_URI w .env.local; testy same używają bazy pociag_test i podnoszą limit ruchu
```

## 2. Stripe (tryb testowy / sandbox)

- [ ] Pracujesz w **sandboxie** (u góry panelu „Sandbox”/„Piaskownica”, klucze `pk_test_` / `sk_test_`). Na koncie live niczego nie konfiguruj.
- [ ] Developers → API keys → **Secret key** `sk_test_…` → do Vercela (punkt 3). Serwer odrzuca każdy inny klucz (D11).
- [ ] Developers → **Webhooks → Add endpoint**:
  - URL: `https://<adres>.vercel.app/api/webhooks/stripe`
  - zdarzenia: `checkout.session.completed` i `checkout.session.async_payment_succeeded`
  - po zapisaniu: **Signing secret** `whsec_…` → do Vercela jako `STRIPE_WEBHOOK_SECRET`.
- [ ] Settings → Team: Kamil i Eryk (Developer), **nauczyciel z rolą tylko do odczytu** (wymóg z PDF-u Etapu II).
- [ ] Opcjonalnie: Settings → Business → Public details → nazwa **Konduktor** (pokazuje się na stronie płatności zamiast „School sandbox”).
- [ ] Po projekcie: Developers → API keys → **Roll key** (klucz `sk_test_` krążył po Discordzie) i podmień go na Vercelu.

## 2a. Voucherify (punkty, sandbox) — [E3]

- [x] Konto, projekt **Sandbox**, region Europe (`https://api.voucherify.io`).
- [x] Loyalty Hub: program „Konduktor punkty” `lprg_1353662608979a6d4e` (ACTIVE), portfel „Punkty” `lcdef_135367367d579a1d98`: bez wygasania, **ujemne saldo niedozwolone**, punkty aktywne od razu. Jedyna reguła naliczania na nieużywane zdarzenie `konduktor_nieuzywane` — punkty dodaje nasz kod.
- [x] Project settings → **Application keys**: Application ID i Secret Key **serwerowe** (nie „Client-side”). Klucze z innego projektu albo klienckie dają `401 Unauthorized`.
- **Limit sandboxa: 100 wywołań na godzinę na cały projekt** (zespół, produkcja, atak i CEO razem). Po `429` aplikacja przestaje wołać Voucherify do końca blokady i płaci bez punktów jak w Etapie II.
- Sprawdzone na sandboxie 11 listopada 2026 (kod kart A i B): założenie karty z 1000 punktami (4 wywołania), pobranie zatwierdzone po ~0,25 s, pobranie ponad saldo → `REJECTED` (`NOT_ENOUGH_BALANCE`), saldo zgodne.

## 2b. Resend (mail z biletem) — [E3]

- [x] Konto (adres właściciela: Mateusz), API key z uprawnieniem **Sending access**.
- Bez własnej domeny nadawca to `onboarding@resend.dev`, a mail dochodzi tylko na adres właściciela konta i adresy testowe: `delivered@resend.dev` (doręczony), `bounced@resend.dev` (odrzucony), z dowolną etykietą po `+`. Inny adres → `403` od Resend, mail „failed”, **bilet działa normalnie** (D19).
- Status maili: Resend → **Emails** (klucz „Sending access” nie czyta maili przez API).
- [x] Sprawdzone 10 listopada 2026: wysyłka na `delivered+test@` i `bounced+test@` przyjęta za pierwszym razem, drugie wywołanie nic nie wysyła (Idempotency-Key).

## 3. Vercel — zmienne środowiskowe (Production)

| Zmienna | Wartość |
|---|---|
| `MONGODB_URI` | connection string z Atlasa (bez zmian) |
| `MONGODB_DB` | `pociag` |
| `RESERVATION_TTL_SECONDS` | **`120`** na testy CEO i demo (liczba całkowita 1–86400) |
| `STRIPE_SECRET_KEY` | `sk_test_…` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` z endpointu w panelu Stripe (NIE ten z `stripe listen`) |
| `APP_URL` | `https://<adres>.vercel.app` — bez `/` na końcu; z niego powstają adresy powrotu ze Stripe |
| `RATE_LIMIT_MAX` | `40` |
| `RATE_LIMIT_WINDOW_SECONDS` | `10` |
| **[E3]** `VOUCHERIFY_API_URL` | `https://api.voucherify.io` |
| **[E3]** `VOUCHERIFY_APP_ID` | Application ID (Sandbox) — uwaga na literówkę `VOUCHERYFY` |
| **[E3]** `VOUCHERIFY_SECRET_KEY` | Secret Key (Sandbox) |
| **[E3]** `VOUCHERIFY_PROGRAM_ID` | `lprg_1353662608979a6d4e` |
| **[E3]** `VOUCHERIFY_CARD_DEFINITION_ID` | `lcdef_135367367d579a1d98` |
| **[E3]** `RESEND_API_KEY` | `re_…` (Sending access) |
| **[E3]** `MAIL_FROM` | `Konduktor <onboarding@resend.dev>` |
| **[E3]** `CRON_SECRET` | losowy, np. `openssl rand -hex 32` |
| **[E3]** `LOYALTY_PROVIDER` / `MAIL_PROVIDER` | nie ustawiaj — na produkcji kod i tak używa `voucherify` i `resend` (D21) |

- [ ] Po zmianie zmiennych: **Deployments → … → Redeploy** (zmienne wchodzą dopiero w nowym deployu).
- [ ] Region funkcji `fra1` (bez zmian od Etapu I).
- Braki widać od razu: brak `APP_URL` albo klucza → „Zapłać” daje 503 i log `[checkout]`; brak `STRIPE_WEBHOOK_SECRET` → webhook daje 400 i log `[webhook]` (Stripe ponawia przez 3 dni, więc po poprawce płatności się dociągną).
- **[E3]** Brak albo zły klucz Voucherify → `GET /api/loyalty` i płatność z punktami dają `503 LOYALTY_UNAVAILABLE`, log `[voucherify] Brak konfiguracji` albo `HTTP 401`; płatność bez punktów działa. Brak `RESEND_API_KEY` → bilet jest, mail „failed”, log `[mail]`.
- [ ] **[E3] Cron:** po redeployu Settings → **Cron Jobs** pokazuje `/api/cron/settle` (codziennie 04:00 UTC). Sprawdzenie bez sekretu: `curl -i https://<adres>.vercel.app/api/cron/settle` → `401`.

## 4. Dane

```bash
# Lokalnie, z .env.local wskazującym na Atlas — ceny kursów (D4) i czyste rezerwacje:
MONGODB_DB=pociag npm run seed
MONGODB_DB=pociag npm run reset -- --yes --prod
```

- `reset` czyści `reservations`, `stripe_events`, `rate_limits` i **[E3]** `loyalty_members` (pamięć podręczna punktów) przez `deleteMany` (indeksy zostają). **Salda w Voucherify zostają** — atak i tak używa za każdym razem nowych e-maili.
- **[E3]** Skrypt ostrzega o rezerwacjach z pobranymi punktami bez zwrotu: po resecie te punkty nie wrócą same. Najpierw `curl -H "Authorization: Bearer $CRON_SECRET" https://<adres>.vercel.app/api/cron/settle`, potem reset.
- **Nie resetuj, gdy ktoś jest w trakcie płatności**: płatność za rezerwację, której nie ma już w bazie, nie dostaje automatycznego zwrotu. Skrypt ostrzega o otwartych sesjach Stripe; zwrot zrobisz wtedy ręcznie w panelu Stripe (Payments → Refund).

## 5. Atak

```bash
# Lokalnie, pełny (z podpisanymi webhookami; serwer musi mieć ten sam STRIPE_WEBHOOK_SECRET):
node scripts/attack.mjs http://localhost:3000 --slow --webhook-secret whsec_dowolny_lokalny

# Na produkcji (bez --webhook-secret — nigdy nie podpisujemy zdarzeń produkcyjnym sekretem):
node scripts/attack.mjs https://<adres>.vercel.app
node scripts/attack.mjs https://<adres>.vercel.app --slow --skip-b5
# Bez Voucherify (np. gdy limit 100/h jest blisko):
node scripts/attack.mjs https://<adres>.vercel.app --skip-loyalty
```

- **[E3] Budżet Voucherify:** część punktowa ataku to ~12 wywołań bez `--slow` i ~21 z `--slow` (skrypt wypisuje szacunek na końcu). Nie puszczaj ataku z punktami częściej niż 3–4 razy na godzinę, a w godzinie testu CEO — wcale przed jego wejściem.
- **[E3]** Każdy przebieg używa nowych klientów `delivered+atk-<przebieg>-<n>@resend.dev` (1000 punktów na start), więc wyniki nie zależą od poprzednich przebiegów.

- [ ] Same PASS. Na produkcji B5 dodatkowo sprawdza, że podrobiony `x-forwarded-for` NIE omija limitu.
- [ ] B5 „drugi klient z innej sieci”: w trakcie ataku zarezerwuj miejsce z telefonu na LTE — ma przejść.
- [ ] Po ataku: `reset` (atak zajmuje do 40 miejsc na czas TTL i kupuje kilka lokalnie).

Wynik lokalny Etapu II (TTL 20 s, prawdziwy klucz testowy Stripe): **55/55 PASS** z `--slow --webhook-secret` (A1, A2, B1–B5, C1–C4, Z6, Z11, Z12, Z27–Z30).

Wynik lokalny Etapu III (11 listopada 2026, TTL 20 s, `LOYALTY_PROVIDER=memory`, `MAIL_PROVIDER=log`, prawdziwy klucz testowy Stripe): **84/84 PASS** z `--slow --webhook-secret`. Dochodzą: saldo nowego klienta 1000 i tylko `{ email, points }` (Z49, Z52), złe `points` → 400 (Z37), ponad połowę ceny → `POINTS_OVER_LIMIT`, ponad saldo → `INSUFFICIENT_POINTS` (Z36), 5× „Zapłać” z 1000 pkt → jeden url i jedno pobranie (Z38), `POINTS_LOCKED` (Z45), `{ amount: 100 }` ignorowane (Z53), płatność 79 zł → `pointsEarned` 790 i powtórka bez drugiego naliczenia (D18, Z41), nieopłacona rezerwacja z 500 pkt → punkty wracają, a „Zapłać” daje 410 (Z39, Z40). Mail z biletem w logu dokładnie raz.

Wynik na produkcji Etapu III (11 listopada 2026, prawdziwy Voucherify sandbox i Resend, TTL 120 s): **67/67 PASS** szybki przebieg (~10 wywołań Voucherify) i **71/71 PASS** z `--slow --skip-b5` (~19 wywołań): A2 1,0 s, B4 1,2 s, C2 5× jeden właściciel, C4 410, zwrot 500 pkt po wygaśnięciu (Z39) i 410 po zwrocie (Z40). Naliczenie punktów po płatności i mail — ręcznie, §6a.

Wynik na produkcji (3 listopada 2026, `68136cf`): **43/43 PASS** szybki przebieg (B5: podrobione nagłówki IP dostają 429 — Vercel nadpisuje je sam) i **45/45 PASS** z `--slow --skip-b5` (A2 1,7 s, B4 1,9 s, C2 5× jeden właściciel, C4 410). Uwaga: przebieg `--slow` czekał 897 s, czyli produkcja miała wtedy TTL 900, a nie 120 — sprawdź `RESERVATION_TTL_SECONDS` przed testem CEO.

## 6. Test kart (ręcznie, na produkcji, po skonfigurowaniu webhooka)

| Krok | Oczekiwane | Lokalnie (bez webhooka, przez synchronizację GET) |
|---|---|---|
| Rezerwacja → „Zapłać 89,00 zł” → `4242 4242 4242 4242` | strona Stripe z opisem miejsca i kwotą → powrót → „Płatność w toku…” → bilet | ✅ bilet `FYC8-7YKK` |
| `4000 0000 0000 0002` | Stripe: „Karta została odrzucona”, rezerwacja dalej `held` | ✅ |
| Strzałka „wróć” na stronie Stripe | `/payment/cancel`: „Nic nie pobraliśmy” + licznik + „Zapłać ponownie” → ta sama sesja Stripe | ✅ |
| `4000 0025 0000 3155` | okno „3D Secure 2 Test Page” → Complete → bilet | ✅ bilet `2ZHK-HMZU` |
| Otwórz stronę Stripe, odczekaj > 2 min (TTL 120), zapłać 4242 | `/payment/success` → „Rezerwacja wygasła… zwrócimy” (po ok. 20 s); w Stripe Dashboard → Payments: płatność ze zwrotem | do zrobienia na produkcji (wymaga webhooka) |
| Developers → Webhooks → endpoint → zdarzenia | `checkout.session.completed` z odpowiedzią 200 | do zrobienia na produkcji |

## 6a. Test punktów i maila (ręcznie, na produkcji) — [E3]

Klient: `delivered+demo<N>@resend.dev` (nowy adres na każdą próbę — 1000 punktów na start).

| Krok | Oczekiwane | Wynik |
|---|---|---|
| `/reserve` → wpisz e-mail | pod polem „Masz 1000 pkt (10,00 zł)…” | do zrobienia |
| Rezerwacja IC 1500 → „Użyj wszystkich” | pole 1000, przycisk „Zapłać 79,00 zł” | do zrobienia |
| „Zapłać” → `4242…` | strona Stripe 79,00 zł z „punkty: −10,00 zł” → bilet z podsumowaniem „kartą 79,00 zł · punktami 1000 pkt · +790 pkt” | do zrobienia |
| Resend → Emails | jeden mail „Bilet XXXX-XXXX — IC 1500 …”, status Delivered | do zrobienia |
| Ponownie `/reserve` tym samym e-mailem | „Masz 790 pkt (7,90 zł)”; w Voucherify (Loyalty Hub → Members) karta z 790 | do zrobienia |
| Zakup bez punktów (nowy e-mail) | bilet „kartą 89,00 zł · +890 pkt”, saldo 1890 | do zrobienia |
| Spóźniona płatność z punktami (otwórz Stripe, czekaj > 2 min, zapłać) | bez biletu, zwrot w Stripe, punkty wracają (saldo znów 1000) | do zrobienia |
| `bounced+demo@resend.dev` | bilet jest; w Resend status Bounced | do zrobienia |
| `stripe trigger checkout.session.completed` (Stripe CLI, konto sandbox) | webhook 200 w Stripe → Webhooks, nic się nie zmienia (II.B2) | do zrobienia |

## 7. Kontrakt CEO — curl-e do skopiowania

```bash
B=https://<adres>.vercel.app
E=ic-1500-2026-12-04

curl -s $B/api/events                      # kursy z price (grosze)
curl -s $B/api/events/$E                   # { event, takenSeats }
curl -s -X POST $B/api/reservations -H 'content-type: application/json' \
  -d '{"eventId":"'$E'","seatId":"2-14","customerName":"Jan Kowalski","email":"jan@example.com"}'
# → 201 { reservationId, expiresAt, amount }; to samo jeszcze raz → 200 z tą samą rezerwacją (B1)
curl -s -X POST $B/api/reservations/<reservationId>/checkout
# → 200 { url } (strona Stripe; ponownie ten sam url); po czasie 410; opłacona 409
curl -s $B/api/reservations/<reservationId>  # { status: held|paid|expired, amount, expiresAt, code? }
curl -s -X POST $B/api/webhooks/stripe -d '{}'  # → 400 INVALID_SIGNATURE
# [E3] punkty
curl -s "$B/api/loyalty?email=delivered%2Bjan%40resend.dev"   # → { email, points: 1000 }
curl -s -X POST $B/api/reservations/<reservationId>/checkout -H 'content-type: application/json' -d '{"points":1000}'
# → 200 { url, pointsUsed: 1000, cardAmount: 7900 }; inna liczba potem → 409 POINTS_LOCKED
curl -s $B/api/reservations/<reservationId>/points         # → { balance, maxPoints, pointsUsed, locked }
curl -s -i $B/api/cron/settle                               # → 401 bez sekretu
```

## Znane zachowania (świadome)

- Zepsute `%`-kodowanie w ścieżce Next.js odrzuca przed naszym kodem: `400` jako HTML (CONTRACT.md §3).
- Lokalnie po 400 na body > 10 kB Node zamyka połączenie keep-alive; `attack.mjs` ponawia i pokazuje `UWAGA`. Na Vercelu połączenie trzyma proxy.
- Limit 40 / 10 s na IP liczy też złe żądania i działa przed walidacją: 41. checkout `abc` w oknie to 429, nie 404.
- Płatność potwierdzona do 10 s po `expiresAt` jest jeszcze przyjmowana (D8); strona sukcesu czeka 20 s po czasie, zanim powie o zwrocie.
- Na stronie Stripe są też BLIK i Klarna (metody płatności włączone w sandboxie). Webhook obsługuje płatności odroczone (`async_payment_succeeded`); na demo pokazuj kartę.
- **[E3]** Zwrot punktów rusza 30 s po wygaśnięciu (zapas na płatność potwierdzoną w ostatniej chwili, D8) — przy odczycie rezerwacji, odczycie salda tego e-maila, w webhooku spóźnionej płatności i raz dziennie w cronie.
- **[E3]** Punkty za zakup dochodzą po odpowiedzi (`after()`), zwykle w ciągu sekundy; `pointsEarned` jest w API od razu.
- **[E3]** `GET /api/loyalty` pozwala sprawdzić saldo dowolnego e-maila (wymóg PDF) — świadomie, odpowiedź ma tylko `email` i `points` (Z49).
