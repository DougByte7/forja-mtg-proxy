import { useMutation } from "@tanstack/preact-query";
import { useEffect, useRef, useState } from "preact/hooks";
import { useLeaveIfLoggedIn } from "../../shared/account";
import { api } from "../../shared/api";
import { returnPath } from "../../shared/redirect";

const MISMATCH = "A confirmação não é igual à senha.";

export function Signup() {
  const [form, setForm] = useState({ nome: "", email: "", senha: "", confirmacao: "", token: "" });
  const [localError, setLocalError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const target = returnPath();
  useLeaveIfLoggedIn(target);

  const create = useMutation({
    mutationFn: () => api("/conta/criar", { body: form }),
    // Não volta o botão ao normal no sucesso: a página está indo embora.
    onSuccess: () => { location.href = target; },
  });
  const busy = create.isPending || create.isSuccess;
  const error = localError || create.error?.message;

  useEffect(() => { nameRef.current?.focus(); }, []);

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onInput: (e: Event) =>
      setForm((f) => ({ ...f, [key]: (e.currentTarget as HTMLInputElement).value })),
  });

  function submit(e: Event) {
    e.preventDefault();
    setLocalError("");
    create.reset();
    // Conferida aqui também, e não só no servidor: a senha digitada duas
    // vezes errada é o erro mais comum desta tela, e ele não precisa de rede.
    if (form.senha !== form.confirmacao) {
      setLocalError(MISMATCH);
      setForm((f) => ({ ...f, confirmacao: "" }));
      confirmRef.current?.focus();
      return;
    }
    create.mutate();
  }

  return (
    <div class="caixa">
      <div class="rune"><span>⌘</span></div>
      <h1>Criar conta</h1>
      <p class="sub">Com a conta você monta baralhos e encontra todos eles em
        qualquer aparelho.</p>

      {error && <div class="erro" role="alert">{error}</div>}

      <form onSubmit={submit}>
        <label for="nome">Nome</label>
        <input class="campo" id="nome" ref={nameRef} autocomplete="name"
               maxLength={80} required {...field("nome")} />

        <label for="email">E-mail</label>
        <input class="campo" id="email" type="email" autocomplete="email"
               autocapitalize="none" spellcheck={false} required {...field("email")} />
        <p class="ajuda">É com ele que você entra.</p>

        <label for="senha">Senha</label>
        <input class="campo" id="senha" type="password" autocomplete="new-password"
               minLength={8} required {...field("senha")} />

        <label for="confirmacao">Confirmação de senha</label>
        <input class="campo" id="confirmacao" ref={confirmRef} type="password"
               autocomplete="new-password" minLength={8} required {...field("confirmacao")} />

        <hr class="separa" />

        <label for="token">Token de acesso</label>
        {/* `autocomplete="off"`: o gerenciador de senhas oferece a senha da
            conta num campo sem nome reconhecível, e o token não é a senha de
            ninguém. */}
        <input class="campo" id="token" autocomplete="off" autocapitalize="none"
               spellcheck={false} required {...field("token")} />
        <p class="ajuda">Peça ao dono do sistema.</p>

        <button class="btn" type="submit" disabled={busy}>
          {busy ? "Criando…" : "Criar conta"}
        </button>
      </form>

      {/* O "Entrar" leva o mesmo destino: quem descobre aqui que já tinha
          conta não pode perder o caminho de volta pro deck que estava abrindo. */}
      <p class="rodape">Já tem conta?{" "}
        <a href={"/entrar?voltar=" + encodeURIComponent(target)}>Entrar</a><br />
        <a href="/">Voltar</a></p>
    </div>
  );
}
