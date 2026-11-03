# DEMO.md — Etap II u CEO (6 minut)

Firma **Konduktor**, wariant: pociąg. Etap II: płatność kartą przez Stripe Checkout (tryb testowy). Prowadzi lider (Mateusz).

## Przed demem (10 minut wcześniej)

- [ ] Vercel: `RESERVATION_TTL_SECONDS=120`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_URL` ustawione, zrobiony redeploy.
- [ ] `MONGODB_DB=pociag npm run reset -- --yes --prod` — czyste miejsca (nikt nie płaci w tym momencie).
- [ ] Otwarte karty: rozkład jazdy (`/`), ten sam kurs na mapie w drugiej karcie, Stripe Dashboard (sandbox) → Payments, terminal z `attack.mjs`.
- [ ] Karty testowe pod ręką: `4242 4242 4242 4242`, `4000 0000 0000 0002`, `4000 0025 0000 3155` (data dowolna przyszła, CVC dowolne).

## Scenariusz

**1. Klient płaci kartą i dostaje bilet (≈ 2 min)**
1. `/`: rozkład jazdy z cenami (89 / 129 / 59 zł). Klik w kurs: mapa wagonu z ceną miejsca.
2. Klik w wolne miejsce: formularz z „Cena miejsca: 89,00 zł”. „Rezerwuję miejsce” → licznik 2:00 i przycisk **„Zapłać 89,00 zł”**.
3. W drugiej karcie mapa: to miejsce jest już szare.
4. „Zapłać” → strona Stripe z nazwą kursu, „Wagon 1, miejsce 5 · …” i kwotą z naszej bazy. Karta `4242…` → „Zapłać”.
5. Powrót: „Płatność w toku…” → po chwili sam bilet z kodem i „Zapłacono 89,00 zł”.
6. Stripe Dashboard → Payments: płatność 89,00 zł; Developers → Webhooks: `checkout.session.completed` → 200.

**2. Odmowa, przerwanie i ponowna płatność (≈ 1,5 min)**
1. Nowa rezerwacja → „Zapłać” → karta `4000 0000 0000 0002` → Stripe: „Karta została odrzucona”. U nas rezerwacja dalej czeka.
2. Strzałka „wróć” na stronie Stripe → „Płatność przerwana. Nic nie pobraliśmy” + licznik + **„Zapłać ponownie”** → ta sama strona Stripe.
3. Karta `4000 0025 0000 3155` → okno 3D Secure → Complete → bilet.

**3. Spóźniona płatność (≈ 30 s opowieści + wynik przygotowany wcześniej)**
Otwieram stronę Stripe, czekam ponad 2 minuty i płacę: rezerwacja już wygasła, więc biletu nie ma, a Stripe Dashboard pokazuje automatyczny zwrot. (Przygotuj to przed demem, żeby nie czekać na żywo.)

**4. Sam atakuję system (≈ 1,5 min)**
```bash
node scripts/attack.mjs https://<adres>.vercel.app
```
Na żywo: kryteria A1–C4 po kolei — identyczna rezerwacja wysłana dwa razy daje tę samą (B1), 20 naraz na jedno miejsce daje 1×201 (B2), 100 rezerwacji w 10 s z jednego klienta daje 429 z `Retry-After` (B5), 5 równoległych „Zapłać” daje jeden adres płatności (C1), webhook bez podpisu daje 400. Na końcu `N/N PASS`.

**5. Lista zagrożeń (≈ 1 min)**: tabela niżej, nowe Z22–Z35.

## Jak obroniliśmy zagrożenia Etapu II (CONTRACT.md §7)

| # | Zagrożenie | Obrona w jednym zdaniu |
|---|---|---|
| Z22 | Ta sama rezerwacja wysłana dwa razy (B1) | Identyczne żądanie tej samej osoby na zajęte przez nią miejsce zwraca tę samą rezerwację (200), inna osoba dostaje 409. |
| Z23 | Jeden klient zalewa API (B5) | 40 żądań / 10 s na IP, liczniki w MongoDB (działa na wielu instancjach Vercela), po limicie 429 z `Retry-After`; inni klienci nie odczuwają. |
| Z24 | Płatność po wygaśnięciu rezerwacji | Webhook nie wystawia biletu i automatycznie zwraca pieniądze. |
| Z25 | Płatność X w chwili, gdy Y rezerwuje to samo miejsce (C2) | Przyjęcie płatności to jedno atomowe przejście, które działa tylko, jeśli rezerwacja X nadal trzyma miejsce — zawsze jeden właściciel, przegrany dostaje zwrot. |
| Z26 | Dwie płatności za jedną rezerwację | Jedna sesja Stripe na rezerwację (klucz idempotencji); gdyby jednak przyszła druga płatność — zwrot. |
| Z27 | Sfałszowany webhook „zapłacone” | Podpis Stripe sprawdzamy na surowym body; bez poprawnego podpisu 400 i nic się nie zmienia. |
| Z28 | Stripe wysyła ten sam webhook kilka razy | Log zdarzeń i atomowe przejścia: powtórka niczego nie zmienia, kod biletu zostaje ten sam. |
| Z29 | Podmieniona kwota albo zmiana ceny po rezerwacji | Kwota zawsze z rezerwacji zapisanej w bazie, nigdy od klienta; webhook sprawdza kwotę i walutę, zła → zwrot. |
| Z30 | Ktoś wchodzi na stronę „sukcesu” bez płacenia | Bilet pokazujemy tylko, gdy w bazie jest `paid`, nigdy na podstawie adresu. |
| Z31 | Webhook się spóźnia albo nie dochodzi | Strona powrotu odpytuje serwer co 2 s, a serwer sam pyta Stripe o sesję i przyjmuje opłaconą. |
| Z32 | Klucze Stripe w repo albo w przeglądarce | Klucze tylko w zmiennych środowiskowych serwera; serwer odrzuca każdy klucz inny niż `sk_test_`. |
| Z33 | Przekierowanie po płatności na obcą domenę | Adresy powrotu budujemy z `APP_URL`, nigdy z nagłówka `Host`. |
| Z34 | Stripe niedostępny | 503 z komunikatem „Płatności chwilowo nie działają”, rezerwacja nietknięta, „Zapłać” można ponowić. |
| Z35 | Karta odrzucona albo 3D Secure | Obsługuje strona Stripe; klient może wrócić i zapłacić ponownie tą samą sesją, dopóki rezerwacja jest ważna. |

Z1–Z21 z Etapu I działają dalej (zakup = teraz płatność) — tabela w historii repo (`git show 06953ef:DEMO.md`).

## Pytania, które mogą paść

**„Dlaczego bilet wystawia webhook, a nie strona powrotu?”**
Na stronę powrotu da się wejść bez płacenia — to zwykły adres. Webhook przychodzi bezpośrednio od Stripe i jest podpisany, więc tylko on (albo nasze zapytanie do Stripe o sesję) może potwierdzić płatność.

**„Co, jeśli klient zapłaci dwa razy?”**
Każde „Zapłać” dla tej samej rezerwacji otwiera tę samą sesję Stripe, więc druga płatność praktycznie nie jest możliwa. Gdyby jednak przyszła, webhook widzi, że rezerwacja jest już opłacona, i zwraca pieniądze.

**„Gdzie są klucze Stripe?”**
Tylko w zmiennych środowiskowych na Vercelu i w lokalnych `.env.local` (w `.gitignore`). Nigdy w repo ani w przeglądarce. Serwer odmawia pracy z kluczem produkcyjnym `sk_live_`.

**„Skąd wiecie, że nie da się podmienić kwoty?”**
Klient nie wysyła kwoty w ogóle. Cena jest zapisywana w rezerwacji w chwili rezerwacji, z niej tworzymy sesję Stripe, a webhook porównuje zapłaconą kwotę z rezerwacją.

**„Co z kryteriami z Etapu I?”**
Naprawiliśmy B1 (identyczna rezerwacja → ta sama, wcześniej 409) i B5 (limit ruchu, wcześniej brak). Reszta była zaliczona i dalej przechodzi w `attack.mjs`.
