/* A entrada. Só o que aparece enquanto não houver token válido; nenhum dado
   de pedido chega ao navegador antes disso. */
import { useEffect, useRef, useState } from "preact/hooks";

export function Gate({ error, busy, onEnter }:
  { error: string; busy: boolean; onEnter: (token: string, remember: boolean) => void }) {
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // A cada erro novo o campo volta vazio e com o foco: o token colado errado
  // não fica ali pra ser reenviado.
  useEffect(() => {
    setValue("");
    input.current?.focus();
  }, [error]);

  function submit(e: Event) {
    e.preventDefault();
    const token = value.trim();
    if (token) onEnter(token, remember);
  }

  return (
    <div id="gate" class="card">
      <h2>Pedidos</h2>
      <p>Esta tela é do operador. Cole o <b>ADMIN_TOKEN</b> do <span class="mono">.env</span> pra continuar.</p>
      <form autocomplete="off" onSubmit={submit}>
        <label class="rotulo" for="tokenInput">Token de administrador</label>
        <input id="tokenInput" ref={input} type="password" placeholder="••••••••••••"
               autocomplete="current-password" value={value}
               onInput={(e) => setValue(e.currentTarget.value)} />
        <label class="lembrar">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} />
          {" "}Lembrar neste navegador
        </label>
        <button class="btn-ouro" type="submit" disabled={busy}>Entrar</button>
      </form>
      {error && <div class="aviso" role="alert" style={{ margin: "14px 0 0" }}>{error}</div>}
    </div>
  );
}
