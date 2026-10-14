/// <reference types="vitest/config" />
/* Build do front da Forja.

   Multi-página: cada tela é um HTML em `pages/` e vira um entry. O build vai
   pra `app/static/dist/`, que o FastAPI serve — o HTML por rota própria (com
   `no-cache`, ver `app/frontend.py`) e os assets, que têm hash no nome, pelo
   mount estático (o CDN, na Vercel). É o hash no nome que substitui o
   versionamento feito à mão que o deckbuilder tinha no `main.py`. */
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { resolve } from "node:path";

const PAGES = ["login", "signup", "decks", "admin", "home", "deckbuilder"];

export default defineConfig({
  plugins: [preact()],
  base: "/dist/",
  build: {
    outDir: resolve(import.meta.dirname, "../app/static/dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries(
        PAGES.map((p) => [p, resolve(import.meta.dirname, `pages/${p}.html`)])),
    },
  },
  server: {
    // Em desenvolvimento a API é o uvicorn em :8000. Tudo que não é arquivo
    // do próprio Vite vai pra lá — inclusive as telas que ainda não migraram.
    proxy: {
      "^/(?!@|src/|pages/|node_modules/).*": "http://localhost:8000",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
