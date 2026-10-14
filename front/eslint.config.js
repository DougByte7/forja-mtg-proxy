/* O que o navegador só confere tarde demais, nos módulos JS que ainda não
   viraram TypeScript (o deckbuilder, por enquanto). O TS já confere isto
   tudo sozinho; aqui são as regras que fazem o mesmo papel no JS:

   - `no-undef`: nome de outro módulo usado sem import. Não impede o módulo
     de carregar — vira `ReferenceError` no clique, na frente de quem usa.
   - `no-import-assign`: atribuir a nome importado é `TypeError` ao rodar;
     quem muda um nome é o módulo dono dele.
   - `no-unused-vars`: import que ninguém usa mente sobre quem depende de quem.

   Import de nome que o outro módulo não exporta, o build do Vite recusa. */
import globals from "globals";

export default [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.browser,
    },
    rules: {
      "no-undef": "error",
      "no-import-assign": "error",
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
    },
  },
];
