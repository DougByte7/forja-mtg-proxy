/* O formulário de entrar ou de criar conta do Clerk, dentro da nossa página.

   A URL continua `/entrar` e `/cadastro`: os passos internos do Clerk
   (código do e-mail, volta do Google, esqueci a senha) andam pelo `#`, então
   o servidor não precisa conhecer rota nenhuma além das duas.

   O destino depois de entrar é o mesmo `?voltar=` de sempre, conferido pelo
   `returnPath` — o Clerk recebe o caminho já validado. */
import { useEffect, useRef, useState } from "preact/hooks";
import { useLeaveIfLoggedIn } from "./account";
import { loadClerk } from "./clerk";
import { returnPath } from "./redirect";
import "./ClerkForm.css";

type Mode = "signIn" | "signUp";

export function ClerkForm({ mode }: { mode: Mode }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const target = returnPath();
  useLeaveIfLoggedIn(target);

  useEffect(() => {
    let mounted: HTMLDivElement | null = null;
    let cancelled = false;
    loadClerk().then((clerk) => {
      if (cancelled || !box.current) return;
      if (!clerk) { setState("failed"); return; }
      const el = box.current;
      const back = encodeURIComponent(target);
      try {
        if (mode === "signIn") {
          clerk.mountSignIn(el, {
            routing: "hash",
            forceRedirectUrl: target,
            signUpUrl: `/cadastro?voltar=${back}`,
          });
        } else {
          clerk.mountSignUp(el, {
            routing: "hash",
            forceRedirectUrl: target,
            signInUrl: `/entrar?voltar=${back}`,
          });
        }
      } catch (e) {
        // Montar falhou (a interface não veio, por exemplo): a tela diz que
        // não abriu, em vez de ficar em "Carregando…" pra sempre.
        console.error(e);
        setState("failed");
        return;
      }
      mounted = el;
      setState("ready");
    });
    return () => {
      cancelled = true;
      if (!mounted) return;
      loadClerk().then((clerk) => {
        if (mode === "signIn") clerk?.unmountSignIn(mounted!);
        else clerk?.unmountSignUp(mounted!);
      });
    };
  }, [mode]);

  return (
    <div class="clerk-pagina">
      {state === "loading" && <p class="sub">Carregando…</p>}
      {state === "failed" && (
        <div class="erro" role="alert">
          Não consegui abrir a tela de {mode === "signIn" ? "entrar" : "criar conta"}.
          Confira a conexão e recarregue a página.
        </div>
      )}
      <div ref={box} />
      <p class="rodape"><a href="/">{mode === "signIn" ? "Voltar sem entrar" : "Voltar"}</a></p>
    </div>
  );
}
