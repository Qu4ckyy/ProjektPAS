# PROMPTY.md — prompty dla agentów (Etap I, Pociąg)

Kolejność i stan:
1. ✅ **Mateusz — Prompt M1 (szkielet)** — PR #1.
2. ✅ **Kamil — Prompt K** — PR #2. ✅ **Eryk — Prompt E** — PR #3.
3. **Eryk — Prompt E2** (przycięcie `expiresAt` do odjazdu) i **Kamil — Prompt K2** (dwie drobne poprawki mapy) — małe, niezależne.
4. **Mateusz — Prompt M2 (frontend B + C)**, potem **Prompt M3 (spięcie, wdrożenie, atak)**.

Każdy wkleja swój prompt do Claude Code w katalogu repo, na świeżym `master` (`git checkout master && git pull`). Potrzebny `.env.local` z `MONGODB_URI` i własną `MONGODB_DB`, potem `npm run seed`.

---

## Prompt M1 — Mateusz: szkielet repo z zaślepkami

```
Jestem liderem 3-osobowego zespołu w projekcie PAS S01: system rezerwacji biletów na POCIĄG. Oceniana jest przede wszystkim NIEZAWODNOŚĆ — CEO będzie atakował API.
W roocie repo jest CONTRACT.md — przeczytaj go w całości, to źródło prawdy. Nie zmieniaj go bez pytania mnie.

ZADANIE: szkielet repo z zaślepkami, żeby Kamil (karta A) i Eryk (backend kart B+C) mogli od razu zacząć pracę równolegle i nikt nie czekał na nikogo. Pracuj na branchu feature/skeleton.

1. Next.js 15 (App Router) + TypeScript strict + Tailwind + ESLint, katalog src/, alias @/*. Zainstaluj `mongodb` (v6). Dev-zależności od razu dla wszystkich (żeby nie było konfliktów w lockfile): `tsx`, `vitest`, `dotenv`.
   Skrypty w package.json: dev, build, start, lint, "seed": "tsx scripts/seed.ts", "test": "vitest run", "attack": "node scripts/attack.mjs".
2. .env.example z MONGODB_URI, MONGODB_DB, RESERVATION_TTL_SECONDS=900 (z komentarzami jak w CONTRACT.md §1). .env.local w .gitignore.
3. Pliki wspólne, w pełni działające (nie zaślepki):
   - src/lib/types.ts — typy TrainEvent, Reservation, odpowiedzi API (CONTRACT.md §2, §3), ErrorCode (lista z §4).
   - src/lib/errors.ts — jsonError(status, error, message) zwracające NextResponse.json({ error, message }, { status }) oraz withErrorHandling / helper do try/catch, który loguje wyjątek i zwraca 500 INTERNAL_ERROR bez szczegółów.
   - src/lib/db.ts — getDb(): jeden MongoClient trzymany w globalThis (ważne na Vercelu i przy hot reload), baza z MONGODB_DB, czytelny błąd gdy brak MONGODB_URI. Pusta funkcja ensureIndexes() wywoływana raz na połączenie (zaimplementuje Eryk).
   - src/lib/config.ts — getReservationTtlSeconds() czytane w czasie żądania (nie przy buildzie), na razie prosto: env albo 900.
   - src/lib/format.ts — formatDate, formatTime, formatDuration(startsAt, arrivesAt) w strefie Europe/Warsaw, locale pl-PL (Intl.DateTimeFormat).
   - src/lib/seats.ts — parseSeatId, isWindow, seatLabel wg CONTRACT.md §2 (proste, działające; Kamil może je dopracować).
4. Zaślepki (zwracają DOKŁADNIE kształty z kontraktu, działają BEZ bazy, każda z komentarzem `// STUB — implementuje <Imię>`):
   - src/data/events.ts — 3 kursy wg §2 (pełne dane, 2 wagony × 20 miejsc). [Kamil]
   - src/lib/events.ts — getEvents(), getEvent(id) czytające z src/data/events.ts. [Kamil]
   - src/lib/reservations.ts — getTakenSeats(eventId) → [], createReservation, purchaseReservation, getReservation, getTicketByCode z zaślepkowymi danymi. [Eryk]
   - Route handlery z `export const dynamic = "force-dynamic"`: GET /api/events, GET /api/events/[id], POST /api/reservations (201 { reservationId: "a".repeat(24), expiresAt: now+TTL }), POST /api/reservations/[id]/purchase (200 { code: "ABCD-EFGH" }), GET /api/reservations/[id] (held, expiresAt = now+TTL, serverNow, event), GET /api/tickets/[code].
     Pamiętaj: w Next 15 params to Promise (`const { id } = await params`).
   - Strony: / (lista kursów z linkami), /events/[id] (siatka miejsc jako linki do /reserve), /reserve (odczyt eventId i seatId z URL — useSearchParams w <Suspense>), /reservations/[param] (wyświetla param). Brzydko, ale klikalnie od początku do końca.
5. src/app/layout.tsx — nagłówek z miejscem na nazwę i logo firmy (na razie "Nazwa firmy"), polski lang="pl".
6. README.md: jak uruchomić (npm i, .env.local, npm run dev, npm run seed), link do CONTRACT.md, kolejność branchy i kto co robi (CONTRACT.md §6).

DEFINICJA "GOTOWE": npm run build i npm run lint przechodzą bez błędów, npm run dev działa BEZ .env.local (zaślepki nie dotykają bazy), cały przepływ / → mapa → /reserve → /reservations/:id da się przeklikać, curl każdego endpointu zwraca kształt z kontraktu.
Zanim zaczniesz, pokaż mi krótki plan. Małe commity (Conventional Commits). Na koniec: opis PR i lista plików z właścicielami.
```

---

## Prompt M2 — Mateusz: frontend kart B i C + nazwa i logo

```
Pracuję w 3-osobowym zespole nad projektem PAS S01: system rezerwacji biletów na POCIĄG (Next.js 15 App Router + TypeScript + Tailwind + MongoDB). Jestem liderem. Oceniana jest przede wszystkim NIEZAWODNOŚĆ.
W roocie repo jest CONTRACT.md — przeczytaj go w całości (szczególnie §2, §3, §4, §5, §6, §7). Nie zmieniaj plików innych osób (§6) — jeśli coś trzeba zmienić poza moimi plikami, zatrzymaj się i napisz mi.
Pracuj na branchu feature/card-bc-frontend (z aktualnego master). Backend jest już GOTOWY (karta A Kamila, karty B+C Eryka) — pracuj na prawdziwym API z lokalną bazą (.env.local, npm run seed).
Obecne src/components/reservation/ReserveForm.tsx i ReservationView.tsx to zaślepki ze szkieletu — przepisz je.

MOJE KARTY: B (rezerwacja) i C (zakup) — frontend. Komponenty w src/components/reservation/.

ZACHOWANIE API (sprawdzone, od Eryka):
- Każdy błąd: { error, message }, message po polsku i nadaje się do pokazania użytkownikowi.
- POST /api/reservations: 201 { reservationId (24 znaki hex, małe litery), expiresAt (ISO) }; 400 VALIDATION_ERROR (message mówi, które pole); 400 INVALID_SEAT; 404 EVENT_NOT_FOUND; 409 SEAT_TAKEN; 409 EVENT_DEPARTED. Uwaga: expiresAt może być krótsze niż TTL, jeśli pociąg odjeżdża wcześniej (§2).
- POST /api/reservations/:id/purchase: 200 { code }; ponowny i równoległy zakup zwraca TEN SAM kod, więc ponowienie po błędzie sieci jest bezpieczne; 404 RESERVATION_NOT_FOUND; 410 RESERVATION_EXPIRED ("Rezerwacja wygasła, miejsce wróciło do puli.").
- GET /api/reservations/:id: { reservationId, eventId, seatId, customerName, status ("held" | "purchased" | "expired"), expiresAt, serverNow, event } + code TYLKO przy "purchased". Bez e-maila.
- GET /api/tickets/:code: { code, seatId, customerName, purchasedAt, event }, kod normalizowany (abcd-efgh też działa); 404 TICKET_NOT_FOUND.
- Walidacja serwera (klient ma walidować TAK SAMO, żeby nie przepuszczać tego, co serwer odrzuci): wszystkie pola po trim; customerName 1–100 znaków, bez znaków sterujących (\n, \t, \0); email max 254, domena z kropką i literową końcówką (jan@localhost → błąd); dodatkowe pola są ignorowane.

0. NAZWA I LOGO: zaproponuj 3 nazwy firmy kolejowo-biletowej (krótkie, po polsku, łatwe do zapamiętania) i do każdej pomysł na logo. Poczekaj, aż wybiorę. Potem: logo jako inline SVG w src/components/brand/Logo.tsx, nazwa w layout.tsx, <title> i favicon. Spójna paleta w Tailwind, pasująca do mapy wagonu Kamila (neutral + emerald + sky).

1. /reserve?eventId=…&seatId=… — formularz rezerwacji:
   - nagłówek: relacja, data i godzina odjazdu (format.ts), "Wagon 2, miejsce 14 · okno" (seats.ts: seatLabel, parseSeatId, isWindow); dane kursu z GET /api/events/:eventId (cache: "no-store"),
   - brak/zły eventId lub seatId w URL, kurs nie istnieje, miejsce spoza kursu → czytelny komunikat + link do rozkładu, bez formularza,
   - kurs już odjechał (hasDeparted z events.ts albo startsAt <= teraz) → komunikat + link do rozkładu, bez formularza,
   - miejsce już jest w takenSeats → komunikat "To miejsce jest już zajęte" + link do mapy,
   - pola: imię i nazwisko, e-mail; walidacja klienta zgodna z serwerem (patrz wyżej), komunikaty przy polach, <label>, autocomplete="name" / "email",
   - wysyłka: przycisk zablokowany w trakcie (brak podwójnego wysłania), POST /api/reservations,
   - 201 → router.push(`/reservations/${reservationId}`),
   - 409 SEAT_TAKEN → "Ktoś był szybszy — to miejsce właśnie zajęto" + link do mapy (Z14); 409 EVENT_DEPARTED, 400, 404 → message z API; błąd sieci / 500 → "Coś poszło nie tak, spróbuj ponownie" (formularz zostaje wypełniony),
   - useSearchParams w <Suspense>.

2. /reservations/[param]:
   - param pasuje do RESERVATION_ID_REGEX z types.ts (^[0-9a-f]{24}$, bez flagi i) → GET /api/reservations/:id:
     - status "held" → podsumowanie (relacja, data i godzina odjazdu, wagon i miejsce, imię) + licznik "Trzymamy Twoje miejsce jeszcze 14:32" + przycisk "Kupuję bilet",
     - licznik: offset = serverNow - Date.now() w chwili pobrania; pozostało = expiresAt - (Date.now() + offset). NIE ufaj samemu zegarowi klienta (Z15). formatCountdown z format.ts. Ostatnia minuta wyróżniona. Przy 0 → stan "wygasła" bez przeładowania i przycisk zablokowany,
     - "Kupuję bilet": przycisk zablokowany po kliknięciu, POST /api/reservations/:id/purchase → 200 → router.replace(`/reservations/${code}`); 410 → stan "wygasła"; 404 → "Nie znaleziono rezerwacji"; błąd sieci → komunikat i przycisk "Spróbuj ponownie" (zakup jest idempotentny),
     - status "purchased" → router.replace(`/reservations/${code}`),
     - status "expired" → "Rezerwacja wygasła, miejsce wróciło do puli" + link do mapy kursu (/events/:eventId) — to wymóg z PDF-u CEO (karta C),
   - param pasuje do formatu kodu (normalizuj: trim + toUpperCase, TICKET_CODE_REGEX z types.ts) → GET /api/tickets/:code → BILET: nazwa i logo firmy, numer pociągu, relacja, data, ODJAZD i przyjazd, wagon, miejsce (okno/korytarz), imię, duży kod. Przycisk "Drukuj" (window.print + style @media print),
   - cokolwiek innego albo 404 → "Nie znaleziono rezerwacji ani biletu" + link do rozkładu,
   - stany ładowania na każdym ekranie.

3. Zasady: fetch zawsze z cache: "no-store"; nigdy dangerouslySetInnerHTML; parametry w URL przez encodeURIComponent; żadnych danych w localStorage; responsywnie (telefon); dostępność (label, aria-live dla licznika co minutę, nie co sekundę; focus na komunikacie po błędzie).

DEFINICJA "GOTOWE": na prawdziwym API da się przejść: mapa → formularz → licznik → zakup → bilet; każdy błąd z kontraktu pokazuje sensowny komunikat. Sprawdź ręcznie: podwójny klik w "Rezerwuję" i "Kupuję bilet", zajęte miejsce (zarezerwuj je w drugiej karcie), wygaśnięcie z RESERVATION_TTL_SECONDS=30, zły kod w URL, jan@localhost w formularzu. npm run build, npm run lint i npm test bez błędów.
Zanim zaczniesz, pokaż mi krótki plan. Małe commity (Conventional Commits), na koniec opis PR.
```

---

## Prompt M3 — Mateusz: spięcie, wdrożenie i atak

```
Jestem liderem zespołu w projekcie PAS S01 (system rezerwacji biletów na POCIĄG, Next.js 15 + MongoDB Atlas, wdrożenie na Vercel). Teraz spinam całość i sam atakuję system przed demem u CEO. Przeczytaj CONTRACT.md w całości, zwłaszcza §2, §3, §4 i §7.
Pracuj na branchu feature/attack (z aktualnego master).

1. scripts/attack.mjs (czysty Node 20+, bez zależności, globalny fetch). Użycie: `node scripts/attack.mjs <BASE_URL>` (domyślnie http://localhost:3000).
   Każdy scenariusz to osobny test z wynikiem PASS/FAIL i krótkim powodem; na końcu tabelka i exit code 1, jeśli coś padło. Scenariusze (zmapowane na zagrożenia z §7):
   - kontrakt: GET /api/events → 200 i tablica z polami z §2; GET /api/events/:id → { event, takenSeats },
   - Z1: 50 równoległych POST /api/reservations na to samo wolne miejsce → dokładnie 1×201, 49×409 SEAT_TAKEN, 0×500; potem miejsce jest w takenSeats,
   - Z4: 10 równoległych purchase tej samej rezerwacji → 10×200 i jeden identyczny kod w formacie z §2; potem GET /api/tickets/:code (też małymi literami) → 200; GET /api/reservations/:id → status "purchased" i ten sam code,
   - Z5: kupione miejsce dalej jest w takenSeats, a ponowna rezerwacja go → 409,
   - Z6: śmieciowe body: brak body, "nie-json", [], null, 123, {}, pola jako liczby/tablice/obiekty, {"eventId":{"$ne":null}}, customerName 10 000 znaków, customerName ze znakiem \n, email "jan@localhost", puste stringi po trim, niepoprawne UTF-8, body 1 MB z Content-Length i bez (chunked) → zawsze 400 VALIDATION_ERROR, nigdy 500,
   - Z7: złe id: /api/events/nie-ma, /api/events/%7B%7D, id 5000 znaków, /api/reservations/abc/purchase, /api/reservations/aaaaaaaaaaaa/purchase, 24 znaki hex WIELKIMI literami, /api/tickets/<losowy poprawny kod> → 404 JSON, nigdy 500.
     Wyjątek (świadoma decyzja, CONTRACT.md §3): zepsute %-kodowanie (np. /api/reservations/%E0%A4%A/purchase) Next.js odrzuca przed handlerem — oczekuj 400 i NIE wymagaj JSON-a, tylko braku 500,
   - Z8: seatId "9-99" → 400 INVALID_SEAT,
   - Z11: GET /api/reservations/:id i GET /api/tickets/:code nie zawierają e-maila (szukaj adresu w całym tekście odpowiedzi),
   - Z12: żadna odpowiedź błędu nie zawiera "at ", "Error:", "Mongo", ścieżek plików,
   - format błędu: każde JSON-owe 4xx/5xx ma { error, message } jako stringi,
   - Z2 + Z3 (flaga --slow): TTL = RESERVATION_TTL_SECONDS serwera, podawany flagą --ttl (domyślnie 120). Po TTL + 1 s (cron nie jest potrzebny): miejsce znika z takenSeats, purchase → 410 RESERVATION_EXPIRED, GET rezerwacji → status "expired", ponowna rezerwacja tego miejsca → 201.
   Skrypt zużywa miejsca — wypisz na starcie, który kurs i które miejsca bierze; wybieraj losowe wolne miejsca, nie zawsze te same.
2. scripts/reset.ts (tsx): czyści rezerwacje w bazie z MONGODB_DB przez deleteMany({}) — NIE drop(), bo drop() kasuje też indeksy, w tym unikalny indeks chroniący przed podwójną rezerwacją (Z1), a działający serwer zakłada je tylko raz na połączenie. Na koniec wywołaj ensureIndexes(db) z src/lib/db.ts (na wszelki wypadek) i seed kursów. Wymaga flagi --yes i wypisuje nazwę bazy oraz liczbę usuniętych rezerwacji. Odmawia, jeśli MONGODB_DB == "pociag" bez dodatkowej flagi --prod. Skrypt "reset" w package.json.
3. Checklista wdrożenia (zapisz jako DEPLOY.md):
   - kolejność merge: feature/card-bc-frontend, potem feature/attack; po każdym merge npm run build, npm run lint, npm test,
   - Vercel: zmienne MONGODB_URI, MONGODB_DB=pociag, RESERVATION_TTL_SECONDS=120 na demo — dokładnie liczba całkowita 1–86400, inaczej serwer bierze 900 i loguje jeden warning; region fra1; Atlas Network Access 0.0.0.0/0 (Vercel nie ma stałego IP); po zmianie env → redeploy,
   - indeksy zakłada samo pierwsze połączenie każdej instancji i npm run seed — w Atlasie nic ręcznie,
   - npm run seed na bazie produkcyjnej, potem attack na URL produkcyjny (najlepiej na preview z osobną bazą), potem reset przed demem,
   - npm test na Atlasie (baza pociag_test) przynajmniej raz — dotąd testy szły tylko lokalnie,
   - curl-e kontraktu CEO do skopiowania (wszystkie endpointy z §3, z przykładowym _id kursu).
4. DEMO.md — scenariusz demo na 5 minut: przejście klienta (rozkład → wagon → formularz → licznik → bilet), wygaśnięcie (TTL 120 s), pokaz attack.mjs na żywo, lista zagrożeń z §7 i jak każde obroniliśmy (jedno zdanie na zagrożenie). Dopisz gotową odpowiedź na pytanie CEO o rozbieżność PDF-ów: POST /api/reservations zwraca { reservationId, expiresAt }, a kod daje osobny zakup (PDF Etapu I).

DEFINICJA "GOTOWE": attack.mjs na lokalnym połączonym systemie i na Vercelu = same PASS (z --slow też); reset działa i po nim Z1 dalej daje dokładnie 1×201; DEPLOY.md i DEMO.md gotowe.
Zanim zaczniesz, pokaż mi krótki plan. Jeśli attack.mjs znajdzie błąd w cudzym pliku — NIE poprawiaj go, tylko opisz: endpoint, wejście, oczekiwany i faktyczny wynik, plik winowajcy (do przekazania właścicielowi).
```

---

## Prompt K — Kamil: karta A (rozkład jazdy i mapa wagonu)

```
Pracuję w 3-osobowym zespole nad projektem PAS S01: system rezerwacji biletów na POCIĄG (Next.js 15 App Router + TypeScript + Tailwind + MongoDB, oficjalny driver `mongodb`). Oceniana jest przede wszystkim NIEZAWODNOŚĆ.
W roocie repo jest CONTRACT.md — przeczytaj go w całości, to źródło prawdy. Nie zmieniaj kontraktu ani plików innych osób (CONTRACT.md §6) — jeśli coś trzeba zmienić poza moimi plikami, zatrzymaj się i napisz mi, co i dlaczego (zgłoszę liderowi). Nie dodawaj zależności do package.json — tsx, dotenv i skrypt "seed" już są; jeśli czegoś brakuje, napisz.
Pracuj na branchu feature/card-a-events. Repo ma już szkielet z zaślepkami.

MOJA KARTA: A — Rozkład jazdy i mapa wagonu (backend + frontend).

BACKEND:
1. src/data/events.ts — dopracuj dane przykładowe: 3 kursy, każdy 2 wagony po 20 miejsc, seatId "<wagon>-<miejsce>" ("1-1".."2-20"), pola wg CONTRACT.md §2 (_id, title, startsAt, seats + trainNumber, from, to, arrivesAt, wagons). Stałe _id (np. "ic-1500-2026-12-04") i stałe daty w grudniu 2026, zapisane jako ISO UTC (pamiętaj: w grudniu Warszawa = UTC+1). Realistyczne relacje i czasy przejazdu.
2. scripts/seed.ts — idempotentny upsert kursów do kolekcji `events` (czyta .env.local przez dotenv, wypisuje nazwę bazy). Nie rusza kolekcji reservations.
3. src/lib/events.ts — getEvents() (posortowane po startsAt), getEvent(id). Zanim użyjesz id w zapytaniu: typeof === "string", długość 1–100 → inaczej zwróć null (ochrona przed NoSQL injection). Sygnatury jak w CONTRACT.md §6 — Eryk woła getEvent.
4. src/lib/seats.ts — parseSeatId, isWindow, seatLabel wg §2 (szkielet ma prostą wersję — dopracuj i obsłuż złe wejście zwracając null, nie wyjątek).
5. GET /api/events → 200, tablica kursów (kształt z kontraktu, bez dodatkowych pól).
6. GET /api/events/:id → 200 { event, takenSeats } gdzie takenSeats = await getTakenSeats(id) z src/lib/reservations.ts (implementuje Eryk — Ty tylko wywołujesz; w szkielecie zwraca []). Nieistniejący kurs → 404 { error: "EVENT_NOT_FOUND", message }. Każdy nieoczekiwany wyjątek → 500 INTERNAL_ERROR bez stack trace (jsonError z src/lib/errors.ts).
7. Każdy route: `export const dynamic = "force-dynamic"` — mapa NIGDY nie może być z cache. W Next 15 params to Promise.

FRONTEND:
8. / — rozkład jazdy: lista kursów jako karty/wiersze: numer pociągu, relacja (from → to), data, odjazd, przyjazd, czas przejazdu, liczba wolnych miejsc. Strona jako server component z `dynamic = "force-dynamic"`, który woła getEvents() i getTakenSeats() bezpośrednio (Promise.all), zamiast dokładać pola do /api/events. Kurs, który już odjechał → oznaczony i nieklikalny. Klik → /events/:id. Daty przez src/lib/format.ts (Europe/Warsaw, pl-PL).
9. /events/:id — mapa wagonu:
   - nagłówek z relacją i godzinami,
   - przełącznik wagonów (zakładki "Wagon 1", "Wagon 2", z liczbą wolnych miejsc; wybrany wagon w URL, np. ?wagon=2, żeby odświeżenie go nie gubiło),
   - wagon narysowany jak w pociągu: układ 2+2, 5 rzędów po 4 miejsca, korytarz pośrodku, oznaczenie kierunku jazdy; okno/korytarz z isWindow,
   - legenda: wolne / zajęte (wyszarzone, nieklikalne, cursor-not-allowed) / okno / korytarz,
   - klik w WOLNE miejsce → /reserve?eventId=<id>&seatId=<seatId> (encodeURIComponent),
   - przycisk "Odśwież" + automatyczne odświeżanie takenSeats co ~10 s i po powrocie na kartę (visibilitychange), żeby nikt nie klikał w miejsce już zajęte,
   - stany: ładowanie, 404 "Nie ma takiego kursu", błąd sieci (z przyciskiem "Spróbuj ponownie"), kurs odjechał (mapa tylko do podglądu),
   - dostępność: miejsca to <button> z aria-label "Wagon 1, miejsce 7, okno, wolne", obsługa klawiatury,
   - responsywne (telefon).
   - Pobieraj dane z cache: "no-store". Nigdy dangerouslySetInnerHTML.
10. Komponenty wrzucaj do src/components/events/.

DEFINICJA "GOTOWE":
- curl /api/events i /api/events/<id> zwracają dokładnie format z kontraktu; /api/events/nie-ma → 404; /api/events/%7B%7D i id 5000 znaków → 404, nie 500.
- npm run seed dwa razy z rzędu nie tworzy duplikatów.
- Po ręcznym wstawieniu do bazy rezerwacji (gdy Eryk skończy) miejsce pokazuje się jako zajęte.
- npm run build i npm run lint bez błędów.
Zanim zaczniesz pisać kod, pokaż mi krótki plan. Małe commity (Conventional Commits), na koniec opis PR z listą zrobionych rzeczy i tym, jak to przetestować.
```

---

## Prompt E — Eryk: backend kart B i C (rezerwacja i zakup)

```
Pracuję w 3-osobowym zespole nad projektem PAS S01: system rezerwacji biletów na POCIĄG (Next.js 15 App Router + TypeScript + MongoDB, oficjalny driver `mongodb`). Oceniana jest przede wszystkim NIEZAWODNOŚĆ — CEO będzie atakował API (równoległe żądania, śmieciowe dane, zakup po czasie). Moja część to serce systemu: ma być kuloodporna.
W roocie repo jest CONTRACT.md — przeczytaj go w całości (szczególnie §2, §3, §4, §5, §7), to źródło prawdy. Nie zmieniaj kontraktu ani plików innych osób (CONTRACT.md §6) — jeśli coś trzeba zmienić poza moimi plikami, zatrzymaj się i napisz mi, co i dlaczego. Nie dodawaj zależności do package.json — vitest, dotenv i skrypt "test" już są; jeśli czegoś brakuje, napisz.
Pracuj na branchu feature/card-bc-reservations. Repo ma już szkielet z zaślepkami.

MOJE KARTY: B (rezerwacja) i C (zakup) — backend.

1. src/lib/db.ts → zaimplementuj ensureIndexes() (wywoływane raz na połączenie, bezpieczne przy wielu równoległych wywołaniach — trzymaj jedną Promise):
   - reservations: UNIKALNY { eventId: 1, seatId: 1 } z partialFilterExpression { active: true },
   - reservations: UNIKALNY { code: 1 } z partialFilterExpression { code: { $type: "string" } },
   - reservations: { eventId: 1, active: 1 }.
   Nie ruszaj cache'owania klienta w globalThis ze szkieletu.
2. src/lib/config.ts — RESERVATION_TTL_SECONDS z env czytane w czasie żądania (nie przy imporcie), walidacja (dodatnia liczba całkowita, inaczej 900 + warning raz).
3. src/lib/validation.ts — walidacja body rezerwacji i id/kodów z URL (osobno, łatwa do testowania).
4. src/lib/reservations.ts:
   - releaseExpired(eventId, seatId?) — updateMany held+active+expiresAt<=now → status "expired", active false,
   - getTakenSeats(eventId) — seatId rezerwacji active:true ORAZ (status "purchased" LUB expiresAt > now). Z tej funkcji korzysta Kamil w GET /api/events/:id — nie zmieniaj jej sygnatury,
   - createReservation(input), purchaseReservation(id), getReservation(id), getTicketByCode(code),
   - generateCode() — crypto.randomBytes, alfabet "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" (bez modulo bias: 256 % 32 == 0, więc byte & 31 jest OK), format XXXX-XXXX, retry przy kolizji unikalnego indeksu (max kilka prób).
   - Kurs pobieraj przez getEvent(id) z src/lib/events.ts (Kamil) — nie czytaj kolekcji events sam.
5. POST /api/reservations — body { eventId, seatId, customerName, email }:
   - body > 10 kB, zły JSON, nie-obiekt (tablica, null, liczba), brak pól, pole nie jest stringiem → 400 VALIDATION_ERROR (typeof === "string" chroni przed NoSQL injection typu {"$ne":null}),
   - trim; customerName 1–100 znaków; email rozsądny regex, max 254; eventId i seatId max 100 znaków; dodatkowe pola ignoruj (nie zapisuj ich do bazy),
   - kurs nie istnieje → 404 EVENT_NOT_FOUND; seatId spoza event.seats → 400 INVALID_SEAT; kurs już odjechał (new Date(startsAt) <= now) → 409 EVENT_DEPARTED,
   - releaseExpired(eventId, seatId) → insertOne({ eventId, seatId, customerName, email, status "held", active true, code null, createdAt, expiresAt = now + TTL }) → błąd E11000 → 409 SEAT_TAKEN,
   - sukces → 201 { reservationId, expiresAt } (reservationId jako hex string, expiresAt jako ISO string).
6. POST /api/reservations/:id/purchase:
   - id nie pasuje do ^[0-9a-f]{24}$ → 404 RESERVATION_NOT_FOUND (nie 500! I nie polegaj na samym ObjectId.isValid — przepuszcza dowolne 12 znaków),
   - atomowo: findOneAndUpdate({ _id, status "held", active true, expiresAt > now }, { $set: { status "purchased", code, purchasedAt } }, { returnDocument: "after" }) → 200 { code },
   - jeśli nie trafiło: brak dokumentu → 404; już purchased → 200 { code } z ISTNIEJĄCYM kodem (idempotencja, podwójny klik); wygasła → oznacz expired/active false i zwróć 410 RESERVATION_EXPIRED.
   - Ignoruj body (zakup nie przyjmuje danych od klienta).
7. GET /api/reservations/:id → { reservationId, eventId, seatId, customerName, status (wyliczony: held z przeszłym expiresAt = "expired"), expiresAt, serverNow, code (tylko gdy purchased), event } — BEZ e-maila. Zły id → 404.
8. GET /api/tickets/:code → { code, seatId, customerName, purchasedAt, event } tylko dla status "purchased"; inaczej 404 TICKET_NOT_FOUND. Kod normalizuj (trim, toUpperCase), sprawdź format przed zapytaniem.
9. Wszystkie route'y: `export const dynamic = "force-dynamic"`, w Next 15 params to Promise, try/catch → 500 INTERNAL_ERROR bez stack trace (jsonError z src/lib/errors.ts), log błędu na serwerze. Format błędów wg CONTRACT.md §4.
10. TESTY (vitest, tests/, osobna baza MONGODB_DB=pociag_test, TTL ustawiany w teście na 2–3 s, kursy testowe wstawiane w setup — w tym jeden, który już odjechał):
   - 50 równoległych rezerwacji tego samego miejsca → dokładnie 1 sukces, reszta SEAT_TAKEN,
   - rezerwacja → po TTL miejsce znika z getTakenSeats i da się je zarezerwować ponownie,
   - purchase po TTL → 410; purchase 2x → ten sam kod; 10 równoległych purchase → 1 kod,
   - kupione miejsce NIGDY nie wraca do puli (także po TTL i po releaseExpired),
   - walidacja: każdy zły input (lista z CONTRACT.md §7 Z6, Z7) → 400/404, nigdy wyjątek,
   - kurs odjechał → 409; nieistniejące miejsce → 400,
   - GET rezerwacji nie zawiera e-maila,
   - kody unikalne (np. 1000 wygenerowanych) i w formacie XXXX-XXXX.
   Testuj na poziomie funkcji z src/lib ORAZ handlerów (wywołuj eksportowane POST/GET z new Request(...)), żeby sprawdzić kody HTTP.

DEFINICJA "GOTOWE": wszystkie testy zielone, npm run build i npm run lint bez błędów, curl-e z kontraktu CEO zwracają dokładnie wymagane kształty i kody HTTP.
Zanim zaczniesz pisać kod, pokaż mi krótki plan. Małe commity (Conventional Commits), na koniec opis PR z listą zagrożeń z CONTRACT.md §7, które obsłużyłem, i jak to przetestować.
```

---

## Prompt E2 — Eryk: przycięcie rezerwacji do odjazdu (Z21)

```
Projekt PAS S01 „Pociąg”. Przeczytaj CONTRACT.md — lider zmienił §2: expiresAt = min(createdAt + RESERVATION_TTL_SECONDS, new Date(event.startsAt)), nowe zagrożenie Z21 w §7.
Pracuj na branchu fix/expires-at-departure (z aktualnego master). Zmieniaj tylko swoje pliki z §6.

1. src/lib/reservations.ts → createReservation: expiresAt = min(createdAt + TTL, startsAt kursu). Kurs, który już odjechał, dalej daje 409 EVENT_DEPARTED (bez zmian).
2. Testy: rezerwacja na kurs odjeżdżający za ~2 s przy TTL 900 → expiresAt == startsAt; po odjeździe purchase → 410 RESERVATION_EXPIRED, GET rezerwacji → status "expired", miejsce znika z takenSeats. Istniejące testy dalej zielone.
3. src/lib/validation.ts: komentarz przy RESERVATION_ID_PATTERN mówi, że RESERVATION_ID_REGEX z types.ts ma flagę i — już nie ma (lider ją usunął). Popraw komentarz; możesz też używać RESERVATION_ID_REGEX zamiast własnej kopii.

DEFINICJA "GOTOWE": npm test, npm run lint, npm run build zielone. Mały PR z opisem.
```

---

## Prompt K2 — Kamil: dwie drobne poprawki mapy wagonu

```
Projekt PAS S01 „Pociąg”, karta A. Przeczytaj CONTRACT.md (§5, §7 Z13). Pracuj na branchu fix/seat-map-refresh (z aktualnego master). Zmieniaj tylko swoje pliki z §6.

1. src/components/events/SeatMap.tsx: po powrocie na mapę przyciskiem „Wstecz” Next.js pokazuje zapamiętaną wersję strony, więc przez max 10 s zajętości mogą być nieaktualne. Pobierz takenSeats od razu po zamontowaniu komponentu (w tym samym efekcie co interwał), nie czekając 10 s.
2. Zmiana wagonu: zamiast router.replace (wysyła zapytanie RSC i renderuje stronę na serwerze) użyj window.history.replaceState(null, "", `?wagon=${n}`) — Next 15 obsługuje to bez przeładowania. Odświeżenie strony ma dalej pamiętać wagon.

DEFINICJA "GOTOWE": po „Wstecz” z /reserve mapa od razu robi GET /api/events/:id (sprawdź w zakładce Network); klik w zakładkę wagonu nie wysyła żądania do serwera; npm run build i npm run lint zielone. Mały PR z opisem.
```
