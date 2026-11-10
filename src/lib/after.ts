// Praca po wysłaniu odpowiedzi (naliczenie punktów, mail) — CONTRACT.md §0a D18, D19. Właściciel: Mateusz.
import { after } from "next/server";

/**
 * after() z next/server: Vercel trzyma funkcję przy życiu, aż zadanie się skończy. Poza żądaniem
 * (testy, skrypty) after() rzuca — wtedy czekamy na zadanie od razu. Zadanie nie może rzucać:
 * błąd tylko w logu, bo odpowiedź już poszła.
 */
export async function runAfterResponse(context: string, task: () => Promise<unknown>): Promise<void> {
  const safe = async () => {
    try {
      await task();
    } catch (err) {
      console.error(`[${context}]`, err);
    }
  };
  try {
    after(safe);
  } catch {
    await safe();
  }
}
