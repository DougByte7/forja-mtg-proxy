import { useQuery, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { isUnauthorized } from "./adminApi";
import { Gate } from "./Gate";
import { Panel } from "./Panel";
import { sessionQuery } from "./queries";
import { gateError, saveToken, token } from "./store";

export function AdminApp() {
  const qc = useQueryClient();
  const t = token.value;
  const sessionQ = useQuery({ ...sessionQuery(t), enabled: !!t });
  // Entrando pela caixa de token, ela fica à vista (com o botão travado) até
  // a sessão responder; com o token já guardado, a tela abre direto no painel.
  const [fromGate, setFromGate] = useState(false);

  // Uma falha na releitura periódica não derruba o painel: só a primeira
  // leitura decide se o token abre a porta. 401 já zerou o token (`adminApi`).
  const failed = sessionQ.isError && !sessionQ.data;
  if (!t || failed || (sessionQ.isPending && fromGate)) {
    const error = gateError.value ||
      (failed && !isUnauthorized(sessionQ.error) ? sessionQ.error.message : "");
    return (
      <Gate error={error} busy={!!t && sessionQ.isFetching}
            onEnter={(value, remember) => {
              setFromGate(true);
              saveToken(value, remember);
              // O mesmo token de uma tentativa que falhou tem de ir de novo.
              qc.resetQueries({ queryKey: ["admin", value] });
            }} />
    );
  }
  if (sessionQ.isPending) return null;
  return <Panel />;
}
