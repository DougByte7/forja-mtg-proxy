/* O botão da conta no cabeçalho: "Entrar" pra anônimo, o nome de quem está
   logado (clique pra sair) pra quem tem conta.

   Só aparece depois de `GET /conta`: piscar de "Entrar" pro nome da pessoa a
   cada carregamento é pior que chegar pronto um instante depois. Se a
   pergunta falhar, a tela segue como anônima. */
import { useCurrentUser, useLogout } from "./account";

export function AccountButton({ returnTo }: { returnTo: string }) {
  const { data: user, isPending } = useCurrentUser();
  const logout = useLogout();
  if (isPending) return null;

  if (!user) {
    return (
      <a class="btn" href={"/entrar?voltar=" + returnTo}
         title="Entrar guarda seus baralhos na conta, pra eles aparecerem em qualquer aparelho.">
        Entrar
      </a>
    );
  }
  return (
    <a class="btn" href="#" title={`Entrou como ${user.login} — clique pra sair.`}
       onClick={(e) => { e.preventDefault(); logout.mutate(); }}>
      {user.nome}
    </a>
  );
}
