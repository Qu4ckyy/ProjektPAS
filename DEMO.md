# DEMO.md — Etap I u CEO (5 minut)

Firma **Konduktor**, wariant: pociąg. Prowadzi lider (Mateusz).

## Przed demem (10 minut wcześniej)

- [ ] Vercel: `RESERVATION_TTL_SECONDS=120`, zrobiony redeploy.
- [ ] `MONGODB_DB=pociag npm run reset -- --yes --prod`, czyli czyste miejsca.
- [ ] Otwarte karty: rozkład jazdy (`/`), drugi kurs na mapie (do pokazania zajętości), terminal z `attack.mjs`.

## Scenariusz

**1. Klient kupuje bilet (≈ 1,5 min)**
1. `/`: rozkład jazdy. Kursy pogrupowane po dniach, odjazd, przyjazd, czas przejazdu, wolne miejsca.
2. Klik w kurs: mapa wagonu. Przełączam Wagon 1 / Wagon 2, pokazuję okno (niebieski pasek) i korytarz.
3. Klik w wolne miejsce: formularz z „Wagon 2, miejsce 14 · przy korytarzu”. Wpisuję `jan@localhost` i pokazuję błąd przy polu.
4. Poprawiam e-mail, „Rezerwuję miejsce”: licznik „Trzymamy Twoje miejsce jeszcze 1:59”.
5. W drugiej karcie mapa: to miejsce jest już szare, bo dla innych wygląda na zajęte.
6. „Kupuję bilet”: bilet z relacją, odjazdem, wagonem, miejscem i kodem `XXXX-XXXX`. „Drukuj”.

**2. Rezerwacja przepada (≈ 1 min)**
1. Rezerwuję inne miejsce i nie kupuję.
2. Licznik w ostatniej minucie robi się pomarańczowy, a przy 0:00 pojawia się „Rezerwacja wygasła, miejsce wróciło do puli”.
3. Mapa: miejsce znowu jest wolne. Rezerwuję je ponownie.

**3. Sam atakuję system (≈ 1,5 min)**
```bash
node scripts/attack.mjs https://<produkcja>.vercel.app
```
Na żywo: 50 równoległych rezerwacji jednego miejsca daje 1×201 i 49×409, 10 równoległych zakupów daje jeden kod, a śmieciowe dane i złe identyfikatory dają 400/404. Na końcu `N/N PASS`.

**4. Lista zagrożeń (≈ 1 min)**: tabela niżej.

## Jak obroniliśmy każde zagrożenie (CONTRACT.md §7)

| # | Zagrożenie | Obrona w jednym zdaniu |
|---|---|---|
| Z1 | Dwie osoby rezerwują to samo miejsce naraz | Unikalny częściowy indeks w MongoDB `{eventId, seatId}` dla aktywnych rezerwacji: baza przepuszcza dokładnie jedną, reszta dostaje 409. |
| Z2 | Wygasła rezerwacja blokuje miejsce na zawsze | Zajętość liczymy z `expiresAt > teraz`, a przed nową rezerwacją wygasłe są zwalniane. Nie potrzeba żadnego crona. |
| Z3 | Zakup po czasie | Zakup to jedno atomowe `findOneAndUpdate` z warunkiem `expiresAt > teraz`; po czasie dostaje 410. |
| Z4 | Podwójny klik / równoległe zakupy | Zakup jest idempotentny: ponowny zwraca ten sam kod, a przyciski blokują się już przy pierwszym kliknięciu. |
| Z5 | Kupione miejsce wraca do puli | Kupiona rezerwacja nigdy nie wygasa i trzyma indeks na zawsze. |
| Z6 | Śmieciowe dane | Każde pole musi być tekstem z limitem długości. Body jest limitowane do 10 kB, a niepoprawny JSON i UTF-8 dają 400. |
| Z7 | Zły identyfikator w adresie | Format sprawdzamy regexem przed zapytaniem do bazy, więc wraca 404, nigdy 500. |
| Z8 | Kurs lub miejsce nie istnieje | 404 `EVENT_NOT_FOUND` / 400 `INVALID_SEAT`, a formularz pokazuje komunikat zamiast pól. |
| Z9 | Rezerwacja na pociąg, który odjechał | 409 `EVENT_DEPARTED`; rozkład i mapa wyszarzają taki kurs. |
| Z10 | Zgadywanie kodów biletów | Kod ma 8 znaków z `crypto.randomBytes`, czyli 32⁸ ≈ 10¹² kombinacji, bez mylących znaków 0/O/1/I. |
| Z11 | Wyciek danych osobowych | E-mail nigdy nie wraca w odpowiedzi API, a bilet po kodzie pokazuje tylko imię. |
| Z12 | Stack trace w odpowiedzi | Każdy wyjątek zamieniamy na 500 `INTERNAL_ERROR` z ogólnym komunikatem, a szczegóły trafiają tylko do logów. |
| Z13 | Mapa z cache pokazuje stare zajętości | `force-dynamic` i `no-store`, odświeżanie co 10 s, po powrocie na kartę i po „Wstecz”. |
| Z14 | Ktoś zajął miejsce, zanim kliknąłem | Formularz obsługuje 409: „Ktoś był szybszy” i powrót do mapy. |
| Z15 | Zegar klienta przestawiony | Licznik liczymy z `serverNow` i `expiresAt` z serwera, nie z zegara telefonu. |
| Z16 | XSS przez imię | React escapuje tekst, nigdzie nie używamy `dangerouslySetInnerHTML`, a znaki sterujące w imieniu dają 400. |
| Z17 | Zła wartość TTL | Walidacja 1–86400 s; zła wartość daje 900 i warning, a nie Invalid Date. |
| Z18 | Burza połączeń do Mongo na Vercelu | Jeden `MongoClient` na instancję, trzymany w `globalThis`. |
| Z19 | Atak wyczerpie miejsca przed demem | `npm run reset` czyści rezerwacje przez `deleteMany`, więc indeksy zostają. |
| Z20 | Godziny w złej strefie | W bazie UTC, w interfejsie zawsze Europe/Warsaw. |
| Z21 | Zakup po odjeździe (rezerwacja tuż przed odjazdem) | `expiresAt` nie wypada później niż odjazd, więc po odjeździe zakup daje 410. |

## Pytania, które mogą paść

**„Prezentacja mówi, że `POST /api/reservations` zwraca `{ reservationId, code }`. Dlaczego zwracacie `expiresAt`?”**
Trzymamy się PDF-u Etapu I, który jest nowszy i dokładniejszy: rezerwacja zwraca `{ reservationId, expiresAt }`, a kod biletu daje dopiero zakup `POST /api/reservations/:id/purchase` → `{ code }`. Tak działa przepływ z PDF-u: rezerwacja na 15 minut, potem „Kupuję” i kod.

**„Co, jeśli dwie instancje na Vercelu przyjmą rezerwację tego samego miejsca w tej samej milisekundzie?”**
Rozstrzyga baza, a nie aplikacja: unikalny indeks działa w MongoDB, więc niezależnie od liczby instancji przechodzi dokładnie jedna rezerwacja.

**„Czy da się zmienić czas rezerwacji bez wdrażania kodu?”**
Tak: zmienna `RESERVATION_TTL_SECONDS` na Vercelu i redeploy. Na testy ustawiamy 120.
