import { useEffect, useRef, useState } from "preact/hooks";
import { api, currentUser } from "../../shared/api";
import { returnPath } from "../../shared/redirect";

export function Login() {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const loginRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const target = returnPath();

  /* Já logado? Então esta tela não tem o que fazer. Acontece com quem clica
     "Entrar" num cabeçalho desatualizado, ou volta pelo histórico. */
  useEffect(() => {
    loginRef.current?.focus();
    currentUser()
      .then((u) => { if (u) location.replace(target); })
      .catch(() => { /* sem rede, a tela de login é o lugar certo pra estar */ });
  }, []);

  async function submit(e: Event) {
    e.preventDefault();
    setError("");
    setSending(true);
    try {
      await api("/conta/entrar", {
        body: { login, senha: password, lembrar: remember },
      });
      location.href = target;
      return;   // não reabilita o botão: a página está indo embora
    } catch (err) {
      setError((err as Error).message);
      setPassword("");
      passwordRef.current?.focus();
    }
    setSending(false);
  }

  return (
    <div class="caixa">
      <div class="rune"><span>⌘</span></div>
      <h1>Entrar</h1>
      {/* A tela diz o que muda com o login, e só isso: montar baralho pede
          conta; abrir um e fazer pedido, não. */}
      <p class="sub">Com a conta você monta baralhos e encontra seus baralhos e
        pedidos em qualquer aparelho.</p>

      {error && <div class="erro" role="alert">{error}</div>}

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

        <button class="btn" type="submit" disabled={sending}>
          {sending ? "Entrando…" : "Entrar"}
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
