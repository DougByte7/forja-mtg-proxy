import { useMutation } from "@tanstack/preact-query";
import { useEffect, useRef, useState } from "preact/hooks";
import { useLeaveIfLoggedIn } from "../../shared/account";
import { api } from "../../shared/api";
import { returnPath } from "../../shared/redirect";

export function Login() {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const loginRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const target = returnPath();
  useLeaveIfLoggedIn(target);

  const enter = useMutation({
    mutationFn: () =>
      api("/conta/entrar", { body: { login, senha: password, lembrar: remember } }),
    // Não volta o botão ao normal no sucesso: a página está indo embora.
    onSuccess: () => { location.href = target; },
    onError: () => {
      setPassword("");
      passwordRef.current?.focus();
    },
  });
  const busy = enter.isPending || enter.isSuccess;

  useEffect(() => { loginRef.current?.focus(); }, []);

  function submit(e: Event) {
    e.preventDefault();
    enter.mutate();
  }

  return (
    <div class="caixa">
      <div class="rune"><span>⌘</span></div>
      <h1>Entrar</h1>
      {/* A tela diz o que muda com o login, e só isso: montar baralho pede
          conta; abrir um e fazer pedido, não. */}
      <p class="sub">Com a conta você monta baralhos e encontra seus baralhos e
        pedidos em qualquer aparelho.</p>

      {enter.error && <div class="erro" role="alert">{enter.error.message}</div>}

      <form onSubmit={submit}>
        <label for="login">E-mail ou login</label>
        <input class="campo" id="login" ref={loginRef} autocomplete="username"
               autocapitalize="none" spellcheck={false} required
               value={login} onInput={(e) => setLogin(e.currentTarget.value)} />

        <label for="senha">Senha</label>
        <input class="campo" id="senha" ref={passwordRef} type="password"
               autocomplete="current-password" required
               value={password} onInput={(e) => setPassword(e.currentTarget.value)} />

        <label class="lembrar">
          <input type="checkbox" checked={remember}
                 onChange={(e) => setRemember(e.currentTarget.checked)} />
          {" "}Continuar conectado neste aparelho
        </label>

        <button class="btn" type="submit" disabled={busy}>
          {busy ? "Entrando…" : "Entrar"}
        </button>
      </form>

      {/* O cadastro leva o mesmo destino: quem descobre aqui que não tem
          conta volta, depois de criar, pra tela que pediu o login. */}
      <p class="rodape">Não tem conta?{" "}
        <a href={"/cadastro?voltar=" + encodeURIComponent(target)}>Criar conta</a><br />
        <a href="/">Voltar sem entrar</a></p>
    </div>
  );
}
