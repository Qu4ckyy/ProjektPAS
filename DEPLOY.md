# DEPLOY.md — wdrożenie Etapu I (Vercel + MongoDB Atlas)

Checklista lidera. Odhaczaj po kolei.

## 1. Merge do `master`

Kolejność: `feature/card-bc-frontend` (M2), potem `feature/attack` (M3).
Po każdym merge na świeżym `master`:

```bash
npm ci
npm run build
npm run lint
npm test          # potrzebny MONGODB_URI w .env.local; testy same używają bazy pociag_test
```

## 2. MongoDB Atlas

- [ ] Klaster we Frankfurcie (najbliżej regionu `fra1` na Vercelu).
- [ ] Użytkownik bazy z prawem odczytu i zapisu.
- [ ] Network Access: `0.0.0.0/0`. Vercel nie ma stałego IP.
- [ ] Indeksów nie zakładasz ręcznie: robi to pierwsze połączenie każdej instancji (`ensureIndexes`) oraz `npm run seed`.
- [ ] Przynajmniej raz `npm test` na Atlasie (baza `pociag_test`). Dotąd testy szły tylko lokalnie.

## 3. Vercel

- [ ] Import repo `Qu4ckyy/ProjektPAS`, framework Next.js, domyślne komendy.
- [ ] Region funkcji: `fra1` (Settings → Functions).
- [ ] Zmienne środowiskowe (Production i Preview):

| Zmienna | Wartość |
|---|---|
| `MONGODB_URI` | connection string z Atlasa |
| `MONGODB_DB` | `pociag` (Production), `pociag_preview` (Preview) |
| `RESERVATION_TTL_SECONDS` | `900` na co dzień, **`120` na demo/testy CEO** |

- `RESERVATION_TTL_SECONDS` przyjmuje tylko liczbę całkowitą 1–86400. Każda inna wartość daje 900 i jeden warning w logach.
- Po każdej zmianie zmiennej zrób **Redeploy**. Zmienne wchodzą dopiero w nowym deployu.

## 4. Dane i atak

```bash
# Lokalnie, z .env.local wskazującym na Atlas:
MONGODB_DB=pociag npm run seed

# Atak najpierw na Preview (osobna baza), potem na produkcję:
node scripts/attack.mjs https://<preview>.vercel.app
node scripts/attack.mjs https://<preview>.vercel.app --slow --ttl 120
node scripts/attack.mjs https://<produkcja>.vercel.app

# Atak zużywa miejsca (kupione nie wracają do puli) — przed demem czyścimy:
MONGODB_DB=pociag npm run reset -- --yes --prod
```

- [ ] `attack.mjs` = same PASS, także z `--slow`.
- [ ] `reset` tuż przed demem. Robi `deleteMany`, a nie `drop`, więc indeksy zostają.

## 5. Kontrakt CEO — curl-e do skopiowania

```bash
B=https://<produkcja>.vercel.app
E=ic-1500-2026-12-04

curl -s $B/api/events
curl -s $B/api/events/$E
curl -s -X POST $B/api/reservations -H 'content-type: application/json' \
  -d '{"eventId":"'$E'","seatId":"2-14","customerName":"Jan Kowalski","email":"jan@example.com"}'
# → 201 {"reservationId":"…","expiresAt":"…"}
curl -s -X POST $B/api/reservations/<reservationId>/purchase
# → 200 {"code":"XXXX-XXXX"}; po czasie → 410 {"error":"RESERVATION_EXPIRED",…}
curl -s $B/api/reservations/<reservationId>
curl -s $B/api/tickets/<code>
```

Strony: `/`, `/events/$E`, `/reserve?eventId=$E&seatId=2-14`, `/reservations/<reservationId>`, `/reservations/<code>`.

## Znane zachowania (świadome)

- Zepsute `%`-kodowanie w ścieżce (np. `/api/reservations/%E0%A4%A/purchase`) Next.js odrzuca przed naszym kodem: `400` jako HTML, nie JSON (CONTRACT.md §3).
- Lokalnie (`next start`), po odpowiedzi 400 na body większe niż 10 kB, Node zamyka połączenie keep-alive bez `Connection: close`. Klient, który użyje tego połączenia ponownie, dostaje jednorazowy `ECONNRESET`. Serwer działa dalej, a `attack.mjs` ponawia takie żądanie i pokazuje `UWAGA`. Na Vercelu połączenie z klientem trzyma proxy, więc nie powinno to wystąpić. Sprawdź `attack.mjs` na Preview.
