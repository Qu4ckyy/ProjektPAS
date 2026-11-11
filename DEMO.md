# DEMO.md — Etap III u CEO (6 minut)

Firma **Konduktor**, wariant: pociąg. Etap III: program lojalnościowy. Klient zbiera punkty w Voucherify (1000 na start, 10 pkt za każdy pełny złoty zapłacony kartą), płaci nimi do połowy ceny (1 pkt = 1 grosz), a po zakupie dostaje mail z biletem przez Resend. Prowadzi lider (Mateusz).

Scenariusz Etapu II (płatność kartą, odmowa, 3D Secure, spóźniona płatność): `git show 6865e21:DEMO.md`. Wszystko z niego działa dalej.

## Przed demem (10 minut wcześniej)

- [ ] Vercel: zmienne z DEPLOY.md §3 (w tym Voucherify, Resend, `CRON_SECRET`), `RESERVATION_TTL_SECONDS=120`, zrobiony redeploy.
- [ ] Zaległe zwroty punktów: `curl -H "Authorization: Bearer $CRON_SECRET" https://<adres>.vercel.app/api/cron/settle`, potem `MONGODB_DB=pociag npm run reset -- --yes --prod` (nikt nie płaci w tym momencie).
- [ ] **Nie puszczaj ataku z punktami w godzinie przed demem** — sandbox Voucherify ma 100 wywołań na godzinę na cały projekt, a CEO też będzie z niego korzystał.
- [ ] Otwarte karty: rozkład jazdy (`/`), Stripe Dashboard → Payments, Voucherify → Loyalty Hub → Members, Resend → Emails, terminal z `attack.mjs`.
- [ ] Przygotowane e-maile klientów (każdy nowy ma 1000 pkt): `delivered+demo1@resend.dev`, `delivered+demo2@resend.dev`, `bounced+demo@resend.dev`.
- [ ] Przygotowany wcześniej przypadek „spóźniona płatność z punktami” (punkt 3), żeby nie czekać 2 minut na żywo.

## Scenariusz

**1. Klient płaci punktami i dostaje bilet mailem (≈ 2,5 min)**
1. Rozkład → kurs IC 1500 → miejsce → formularz. Wpisz `delivered+demo1@resend.dev`: pod polem „Masz 1000 pkt (10,00 zł)…”.
2. „Rezerwuję miejsce” → licznik i pole **„Użyj punktów”** z podpowiedzią „Najwięcej: 1000 pkt”. „Użyj wszystkich” → przycisk od razu zmienia się na **„Zapłać 79,00 zł”**.
3. Pokaż walidację: wpisz 5000 → „Najwięcej możesz użyć 1000 pkt.” i zablokowany przycisk. Wróć do 1000.
4. „Zapłać” → strona Stripe na **79,00 zł** z dopiskiem „punkty: −10,00 zł”. Karta `4242…`.
5. Bilet z podsumowaniem: **kartą 79,00 zł · punktami 1000 pkt (10,00 zł) · zebrane punkty +790** i „Wysyłamy bilet także na Twój e-mail”.
6. Resend → Emails: mail „Bilet XXXX-XXXX — IC 1500 …” (Delivered). Voucherify → Members: karta klienta z saldem 790 (+1000, −1000, +790).
7. Nowa rezerwacja tym samym e-mailem: formularz pokazuje „Masz 790 pkt”.

**2. Zakup bez punktów (≈ 45 s)**
`delivered+demo2@resend.dev`, bez punktów → „Zapłać 89,00 zł” → bilet „kartą 89,00 zł · +890 pkt” → saldo 1890. Punkty liczymy tylko od części zapłaconej kartą, od pełnych złotych.

**3. Spóźniona płatność z punktami (≈ 30 s opowieści + wynik przygotowany wcześniej)**
Otworzyłem stronę Stripe z punktami, czekałem ponad 2 minuty i zapłaciłem. Rezerwacja już wygasła, więc biletu nie ma, Stripe Dashboard pokazuje automatyczny zwrot pieniędzy, a punkty wróciły na kartę w Voucherify.

**4. Sam atakuję system (≈ 1,5 min)**
```bash
node scripts/attack.mjs https://<adres>.vercel.app
```
Na żywo, obok kryteriów etapów I i II:
- `GET /api/loyalty` nowego e-maila daje 1000 i tylko `{ email, points }`,
- złe `points` (tekst, ułamek, ujemne) dają 400, ponad połowę ceny `POINTS_OVER_LIMIT`, a ponad saldo `INSUFFICIENT_POINTS`,
- 5 równoległych „Zapłać” z 1000 pkt daje jeden adres płatności i jedno pobranie punktów,
- inna liczba punktów po pierwszym „Zapłać” daje `POINTS_LOCKED`,
- na końcu `N/N PASS` i szacunek wywołań Voucherify.

**5. Lista zagrożeń (≈ 1 min)**: tabela niżej, Z36–Z55.

## Jak obroniliśmy zagrożenia Etapu III (CONTRACT.md §7)

| # | Zagrożenie | Obrona w jednym zdaniu |
|---|---|---|
| Z36 | Ten sam klient wydaje punkty naraz na dwie rezerwacje | Blokada wydawania na e-mail i świeże saldo z Voucherify tuż przed pobraniem, a portfel w Voucherify nie pozwala zejść poniżej zera. |
| Z37 | Złe `points` (tekst, ułamek, ujemne, ponad połowę ceny) | Walidacja → 400, Voucherify nawet nie jest wołany. |
| Z38 | Podwójne „Zapłać” z punktami | Atomowe zajęcie pobrania w rezerwacji: punkty schodzą raz, wszyscy dostają ten sam adres płatności. |
| Z39 | Punkty pobrane, a klient nie zapłacił | Po wygaśnięciu punkty wracają na kartę — przy odczycie rezerwacji, salda, i raz dziennie w cronie. |
| Z40 | Płatność kartą po wygaśnięciu rezerwacji z punktami | Zwrot punktów zamyka rezerwację, więc spóźniona płatność dostaje zwrot pieniędzy, a nie bilet za darmo. |
| Z41 | Punkty za zakup naliczone dwa razy | Naliczenie zajmuje jeden wykonawca, a każda operacja ma unikalny opis sprawdzany przed ponowieniem. |
| Z42 | Punkty liczone od całej ceny albo od groszy | Jeden wzór dla wszystkich: `floor(kwota kartą / 100) × 10`. |
| Z43 | Voucherify nie działa albo limit 100/h | Płatność bez punktów działa jak w Etapie II, z punktami „Punkty chwilowo nie działają”, naliczenia i zwroty czekają na ponowienie. |
| Z44 | Timeout przy pobraniu — nie wiadomo, czy punkty zeszły | Sprawdzamy historię transakcji karty po naszym opisie operacji, zanim spróbujemy drugi raz. |
| Z45 | Zmiana liczby punktów po otwarciu strony Stripe | Punkty są zablokowane po pierwszym „Zapłać” (`409 POINTS_LOCKED`), a webhook sprawdza, że kwota to cena minus punkty. |
| Z46 | Mail z biletem wysłany dwa razy | Atomowe zajęcie wysyłki i klucz idempotencji `ticket-<id>` w Resend. |
| Z47 | Mail nie dochodzi (Resend nie działa, adres odrzucony) | Bilet działa bez maila; mail ponawiamy do 5 razy, odrzucony adres oznaczamy jako nieudany. |
| Z48 | HTML albo link wstrzyknięty w imieniu do maila | Wszystkie dane klienta w mailu są escapowane. |
| Z49 | Podgląd salda cudzego e-maila | Wymóg PDF; odpowiedź ma tylko `email` i `points`, z limitem ruchu. |
| Z50 | Klucze Voucherify/Resend w repo albo w przeglądarce | Tylko zmienne środowiskowe serwera; treść błędów usług tylko w logach. |
| Z51 | 1000 punktów powitalnych dodane dwa razy | Atomowe „zakładanie karty” w bazie; powitalne dokładnie raz na e-mail. |
| Z52 | `Jan@Example.com` i `jan@example.com` jako dwa konta | E-mail zawsze po `trim` i małymi literami. |
| Z53 | Kwota z body checkoutu (`{ "amount": 100 }`) | Z body liczy się tylko `points`, kwota zawsze z bazy. |
| Z54 | Operacja przerwana w połowie (padła funkcja na Vercelu) | Kroki zawieszone dłużej niż 2 minuty przejmuje następny odczyt albo cron, po sprawdzeniu transakcji. |
| Z55 | Voucherify przyjął pobranie, ale je odrzucił albo jeszcze przetwarza | Sesja Stripe ze zniżką dopiero po zatwierdzeniu (`APPROVED`); odrzucone → „za mało punktów”. |

Z1–Z21 (Etap I) i Z22–Z35 (Etap II) działają dalej — tabela Etapu II: `git show 6865e21:DEMO.md`.

## Pytania, które mogą paść

**„Dlaczego punkty schodzą już przy »Zapłać«, a nie po płatności?”**
Tak opisuje to karta B. Sesja Stripe jest na kwotę po odjęciu punktów, więc punkty muszą zejść wcześniej — inaczej klient mógłby zapłacić mniej, a punkty wydać jeszcze raz gdzie indziej.

**„A jeśli klient nie zapłaci?”**
Punkty wracają na kartę 30 s po wygaśnięciu rezerwacji. Zwrot zamyka rezerwację, więc spóźniona płatność dostaje zwrot pieniędzy, a nie bilet.

**„Co, jeśli Voucherify padnie?”**
Zakup bez punktów w ogóle go nie woła, więc działa jak w Etapie II. Z punktami klient widzi „Punkty chwilowo nie działają” i może zapłacić bez nich. Naliczenia po zakupie czekają i dochodzą przy kolejnym odczycie albo w cronie.

**„Skąd pewność, że mail nie przyjdzie dwa razy?”**
Wysyłkę zajmuje atomowo jeden proces, a Resend dostaje klucz idempotencji `ticket-<reservationId>` — drugi taki sam request przez 24 h niczego nie wysyła.

**„Skąd wiecie, ile macie punktów? Trzymacie saldo u siebie?”**
Nie — źródłem prawdy jest Voucherify. U siebie pamiętamy tylko, ile punktów rezerwacja użyła i zebrała, mapę e-mail → karta i krótką pamięć podręczną salda, żeby zmieścić się w limicie 100 wywołań na godzinę.

**„PDF mówi o /v1/loyalties/members/…/balance, a wy?”**
Nowe konta Voucherify mają już tylko Loyalty Hub v2 i dwóch modeli nie da się mieszać. Odpowiednikiem jest `POST /v2/…/cards/{cardId}/points`; zasady (punkty dodatnie dodają, ujemne odejmują) są te same.
