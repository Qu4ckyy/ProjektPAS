# Pociąg — PAS S01

System rezerwacji miejsc w pociągach. Next.js 15 (App Router) + TypeScript + Tailwind + MongoDB Atlas, wdrożenie na Vercel.

**Źródło prawdy: [CONTRACT.md](CONTRACT.md).** Prompty dla agentów: [PROMPTY.md](PROMPTY.md).

## Uruchomienie

```bash
npm install
cp .env.example .env.local   # uzupełnij MONGODB_URI i swoją MONGODB_DB
npm run dev                  # http://localhost:3000
```

Szkielet działa bez `.env.local` — zaślepki nie dotykają bazy. Baza jest potrzebna dopiero, gdy wejdą prawdziwe implementacje.

| Skrypt | Co robi |
|---|---|
| `npm run dev` | serwer deweloperski |
| `npm run build` | build produkcyjny |
| `npm run lint` | ESLint |
| `npm run seed` | wgrywa kursy do kolekcji `events` (Kamil) |
| `npm test` | testy vitest (Eryk), na bazie `pociag_test` |
| `npm run attack` | atak na API wg CONTRACT.md §7 (Mateusz) |

## Kto co robi

| Osoba | Karta | Branch |
|---|---|---|
| Mateusz (lider) | szkielet, frontend kart B + C, nazwa i logo, atak i wdrożenie | `feature/skeleton`, `feature/card-bc-frontend`, `feature/attack` |
| Kamil | A: rozkład jazdy i mapa wagonu (backend + frontend) | `feature/card-a-events` |
| Eryk | B + C backend: rezerwacja, zakup, wygasanie, testy | `feature/card-bc-reservations` |

Pliki i ich właściciele: CONTRACT.md §6. Edytujesz tylko swoje — zmiana w cudzym pliku idzie przez lidera.
Pliki-zaślepki mają na górze komentarz `// STUB — implementuje <Imię>`.

## Zasady

- Branch na kartę, PR do `master`, review robi lider.
- Conventional Commits: `feat:`, `fix:`, `test:`, `chore:`, `docs:`.
- Przed PR: `npm run build`, `npm run lint`, `npm test`.
