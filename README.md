# Pociąg — PAS S01

System rezerwacji miejsc w pociągach. Next.js 15 (App Router) + TypeScript + Tailwind + MongoDB Atlas, wdrożenie na Vercel.

**Źródło prawdy: [CONTRACT.md](CONTRACT.md).** Prompty dla agentów: [PROMPTY.md](PROMPTY.md). Wdrożenie: [DEPLOY.md](DEPLOY.md). Demo: [DEMO.md](DEMO.md).

## Uruchomienie

```bash
npm install
cp .env.example .env.local   # uzupełnij MONGODB_URI i swoją MONGODB_DB
npm run seed                 # kursy do kolekcji events (bezpiecznie puszczać wiele razy)
npm run dev                  # http://localhost:3000
```

Aplikacja wymaga bazy: bez `MONGODB_URI` w `.env.local` rozkład jazdy, mapa i całe API rezerwacji zwracają błąd.
Indeksy kolekcji `reservations` zakłada samo pierwsze połączenie (i `npm run seed`), więc w Atlasie nie trzeba nic robić ręcznie.

`npm test` też potrzebuje `MONGODB_URI` w `.env.local`, ale zawsze sam przełącza się na bazę `pociag_test` i ją czyści, więc nie rusza Twoich danych.

| Skrypt | Co robi |
|---|---|
| `npm run dev` | serwer deweloperski |
| `npm run build` | build produkcyjny |
| `npm run lint` | ESLint |
| `npm run seed` | wgrywa kursy do kolekcji `events` (Kamil) |
| `npm test` | testy vitest (Eryk), na bazie `pociag_test` |
| `npm run attack -- <URL> [--slow --ttl 120]` | atak na API wg CONTRACT.md §7 (Mateusz) |
| `npm run reset -- --yes` | czyści rezerwacje i wgrywa kursy od nowa (`--prod` dla bazy `pociag`) |

## Kto co zrobił (Etap I)

| Osoba | Karta | PR |
|---|---|---|
| Mateusz (lider) | szkielet, frontend kart B + C, nazwa i logo, atak i wdrożenie | #1, #4, #5, #6 |
| Kamil | A: rozkład jazdy i mapa wagonu (backend + frontend) | #2 |
| Eryk | B + C backend: rezerwacja, zakup, wygasanie, testy | #3 |

Pliki i ich właściciele: CONTRACT.md §6. Edytujesz tylko swoje — zmiana w cudzym pliku idzie przez lidera.

## Zasady

- Branch na kartę, PR do `master`, review robi lider.
- Conventional Commits: `feat:`, `fix:`, `test:`, `chore:`, `docs:`.
- Przed PR: `npm run build`, `npm run lint`, `npm test`.
