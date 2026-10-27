import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    // Pliki z bazą dzielą pociag_test — jeden po drugim, żeby nie czyściły sobie danych.
    fileParallelism: false,
    // Testy wygasania czekają na TTL (2 s), a Atlas dokłada opóźnienie sieci.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
