# DEPLOY.md — wdrożenie Etapu II (Vercel + MongoDB Atlas + Stripe)

Checklista lidera. Odhaczaj po kolei. Atlas i podstawowy Vercel są już skonfigurowane z Etapu I — tu jest to, co doszło.

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

- [ ] Po zmianie zmiennych: **Deployments → … → Redeploy** (zmienne wchodzą dopiero w nowym deployu).
- [ ] Region funkcji `fra1` (bez zmian od Etapu I).
- Braki widać od razu: brak `APP_URL` albo klucza → „Zapłać” daje 503 i log `[checkout]`; brak `STRIPE_WEBHOOK_SECRET` → webhook daje 400 i log `[webhook]` (Stripe ponawia przez 3 dni, więc po poprawce płatności się dociągną).

## 4. Dane

```bash
# Lokalnie, z .env.local wskazującym na Atlas — ceny kursów (D4) i czyste rezerwacje:
MONGODB_DB=pociag npm run seed
MONGODB_DB=pociag npm run reset -- --yes --prod
```

- `reset` czyści `reservations`, `stripe_events` i `rate_limits` przez `deleteMany` (indeksy zostają).
- **Nie resetuj, gdy ktoś jest w trakcie płatności**: płatność za rezerwację, której nie ma już w bazie, nie dostaje automatycznego zwrotu. Skrypt ostrzega o otwartych sesjach Stripe; zwrot zrobisz wtedy ręcznie w panelu Stripe (Payments → Refund).

## 5. Atak

```bash
# Lokalnie, pełny (z podpisanymi webhookami; serwer musi mieć ten sam STRIPE_WEBHOOK_SECRET):
node scripts/attack.mjs http://localhost:3000 --slow --webhook-secret whsec_dowolny_lokalny

# Na produkcji (bez --webhook-secret — nigdy nie podpisujemy zdarzeń produkcyjnym sekretem):
node scripts/attack.mjs https://<adres>.vercel.app
node scripts/attack.mjs https://<adres>.vercel.app --slow
```

- [ ] Same PASS. Na produkcji B5 dodatkowo sprawdza, że podrobiony `x-forwarded-for` NIE omija limitu.
- [ ] B5 „drugi klient z innej sieci”: w trakcie ataku zarezerwuj miejsce z telefonu na LTE — ma przejść.
- [ ] Po ataku: `reset` (atak zajmuje do 40 miejsc na czas TTL i kupuje kilka lokalnie).

Wynik lokalny (TTL 20 s, prawdziwy klucz testowy Stripe): **55/55 PASS** z `--slow --webhook-secret` (A1, A2, B1–B5, C1–C4, Z6, Z11, Z12, Z27–Z30).

## 6. Test kart (ręcznie, na produkcji, po skonfigurowaniu webhooka)

| Krok | Oczekiwane | Lokalnie (bez webhooka, przez synchronizację GET) |
|---|---|---|
| Rezerwacja → „Zapłać 89,00 zł” → `4242 4242 4242 4242` | strona Stripe z opisem miejsca i kwotą → powrót → „Płatność w toku…” → bilet | ✅ bilet `FYC8-7YKK` |
| `4000 0000 0000 0002` | Stripe: „Karta została odrzucona”, rezerwacja dalej `held` | ✅ |
| Strzałka „wróć” na stronie Stripe | `/payment/cancel`: „Nic nie pobraliśmy” + licznik + „Zapłać ponownie” → ta sama sesja Stripe | ✅ |
| `4000 0025 0000 3155` | okno „3D Secure 2 Test Page” → Complete → bilet | ✅ bilet `2ZHK-HMZU` |
| Otwórz stronę Stripe, odczekaj > 2 min (TTL 120), zapłać 4242 | `/payment/success` → „Rezerwacja wygasła… zwrócimy” (po ok. 20 s); w Stripe Dashboard → Payments: płatność ze zwrotem | do zrobienia na produkcji (wymaga webhooka) |
| Developers → Webhooks → endpoint → zdarzenia | `checkout.session.completed` z odpowiedzią 200 | do zrobienia na produkcji |

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
```

## Znane zachowania (świadome)

- Zepsute `%`-kodowanie w ścieżce Next.js odrzuca przed naszym kodem: `400` jako HTML (CONTRACT.md §3).
- Lokalnie po 400 na body > 10 kB Node zamyka połączenie keep-alive; `attack.mjs` ponawia i pokazuje `UWAGA`. Na Vercelu połączenie trzyma proxy.
- Limit 40 / 10 s na IP liczy też złe żądania i działa przed walidacją: 41. checkout `abc` w oknie to 429, nie 404.
- Płatność potwierdzona do 10 s po `expiresAt` jest jeszcze przyjmowana (D8); strona sukcesu czeka 20 s po czasie, zanim powie o zwrocie.
- Na stronie Stripe są też BLIK i Klarna (metody płatności włączone w sandboxie). Webhook obsługuje płatności odroczone (`async_payment_succeeded`); na demo pokazuj kartę.
