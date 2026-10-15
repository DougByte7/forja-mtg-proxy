/* O Clerk no navegador: quem cuida de entrar, criar conta, confirmar e-mail,
   "esqueci a senha" e Google.

   Carregado uma vez só por página, na primeira chamada à API (ou na tela de
   entrar), e da CDN do Clerk — nada dele entra no nosso bundle além da
   tradução. São duas peças: o `clerk-js` (sessão e token, em toda página) e
   a interface dos formulários (`@clerk/ui`, com o React dela por dentro),
   que só as telas de entrar e de cadastro pedem (`withClerkUi`) — e só
   elas baixam junto a tradução. Aqui não entra React nenhum.

   O token de sessão vale um minuto e o `clerk-js` o renova sozinho. O `api`
   pede um fresco a cada chamada (`sessionToken`), que sai do cache dele na
   maior parte das vezes.

   Sem `VITE_CLERK_PUBLISHABLE_KEY` no build o Clerk fica desligado: todo
   mundo é anônimo, e as telas de entrar e cadastro dizem que não abriram. */
import type { Clerk } from "@clerk/clerk-js";

const KEY = (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined) || "";

export const clerkEnabled = Boolean(KEY);

/* A paleta das telas de conta (`login/style.css`), pros formulários do Clerk
   parecerem da casa. */
const appearance = {
  variables: {
    colorPrimary: "#E9C765",
    colorPrimaryForeground: "#1A1024",
    colorBackground: "#1B1730",
    colorForeground: "#EDE6D6",
    colorMutedForeground: "#A79BC7",
    colorInput: "#16112A",
    colorInputForeground: "#EDE6D6",
    colorNeutral: "#EDE6D6",
    colorBorder: "#382F5C",
    colorDanger: "#D9634A",
    colorRing: "#E9C765",
    fontFamily: "Inter, sans-serif",
    borderRadius: "9px",
  },
};

declare global {
  interface Window {
    Clerk?: Clerk;
    /** O que o `ui.browser.js` do Clerk deixa na janela ao carregar. */
    __internal_ClerkUICtor?: unknown;
  }
}

/* O domínio da instância (a "Frontend API") vai dentro da própria chave:
   `pk_test_<base64 de "dominio$">`. */
export function frontendApi(key: string): string {
  const encoded = key.split("_")[2] ?? "";
  const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
  return atob(padded).replace(/\$$/, "");
}

/* O `clerk-js` vem da CDN do Clerk, e não do nosso bundle: o build de
   navegador tem ~80 KB e baixa o resto sob demanda, enquanto o pacote do npm
   empacotado aqui passaria de 500 KB (Stripe, carteiras de cripto...) em toda
   página. A versão é a MAIOR, a mesma regra dos SDKs do Clerk; os tipos vêm
   do pacote do npm, na mesma maior. */
const CLERK_JS_MAJOR = "6";
const CLERK_UI_MAJOR = "1";

function injectScript(path: string, data: Record<string, string> = {}): Promise<void> {
  return new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = `https://${frontendApi(KEY)}/npm/${path}`;
    s.async = true;
    s.crossOrigin = "anonymous";
    Object.assign(s.dataset, data);
    s.onload = () => ok();
    s.onerror = () => fail(new Error(`${path} não baixou`));
    document.head.appendChild(s);
  });
}

/* A interface só entra se a tela pedir ANTES do primeiro `loadClerk`: o
   `clerk-js` recebe o construtor dela no `load`, e sem ele o `mountSignIn`
   falha com "Clerk was not loaded with Ui components". Por isso a chamada
   mora no `main.tsx` das duas telas, antes do `mount`. */
let wantUi = false;

export function withClerkUi() {
  wantUi = true;
}

let loading: Promise<Clerk | null> | null = null;

/** O Clerk pronto, ou `null` se ele estiver desligado ou não carregar. Nunca
    rejeita: Clerk fora do ar deixa a pessoa anônima, não a tela quebrada. */
export function loadClerk(): Promise<Clerk | null> {
  if (!clerkEnabled) return Promise.resolve(null);
  loading ??= (async () => {
    const [, , translation] = await Promise.all([
      window.Clerk ? null : injectScript(
        `@clerk/clerk-js@${CLERK_JS_MAJOR}/dist/clerk.browser.js`,
        { clerkPublishableKey: KEY }),
      wantUi && !window.__internal_ClerkUICtor
        ? injectScript(`@clerk/ui@${CLERK_UI_MAJOR}/dist/ui.browser.js`) : null,
      wantUi ? import("@clerk/localizations/pt-BR") : null,
    ]);
    const clerk = window.Clerk;
    if (!clerk) throw new Error("clerk-js baixou, mas não se apresentou");
    await clerk.load({
      signInUrl: "/entrar",
      signUpUrl: "/cadastro",
      ...(wantUi && {
        ui: { ClerkUI: window.__internal_ClerkUICtor as never },
        localization: translation?.ptBR,
        appearance,
      }),
    });
    return clerk;
  })().catch((e) => {
    console.warn("Clerk não carregou; seguindo como anônimo.", e);
    return null;
  });
  return loading;
}

/* Quanto o `api` espera pelo Clerk antes de seguir sem token. Carregar é uma
   ida à CDN dele; passar disto é rede ruim ou bloqueador, e a resposta certa
   é a tela andar como anônima em vez de ficar parada. */
const WAIT_MS = 4000;

/** O token de sessão pra mandar no `Authorization`, ou `null` (anônimo). */
export async function sessionToken(): Promise<string | null> {
  if (!clerkEnabled) return null;
  const timeout = new Promise<null>((ok) => setTimeout(() => ok(null), WAIT_MS));
  const clerk = await Promise.race([loadClerk(), timeout]);
  if (!clerk?.session) return null;
  try {
    return await clerk.session.getToken();
  } catch {
    return null;
  }
}

/** Sai do Clerk (se ele estiver ligado). */
export async function signOutClerk() {
  const clerk = await loadClerk();
  await clerk?.signOut().catch(() => {});
}
