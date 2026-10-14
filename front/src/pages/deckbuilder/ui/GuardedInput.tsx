/* Um campo cujo valor vem do estado, mas que não é reescrito enquanto tem o
   foco. O estado guarda a versão limpa do que se digitou (o texto aparado, o
   número normalizado), e escrever essa versão de volta no meio da digitação
   comeria o espaço entre duas palavras ou o ponto de "2.5". Fora do foco, o
   campo acompanha o estado — limpar os filtros, desfazer — normalmente. */
import { useLayoutEffect, useRef } from "preact/hooks";

/* Os demais atributos passam direto pro <input>. (Os tipos de atributo do
   Preact 11 são uma união por `type` do campo, que não aceita um repasse
   genérico; aqui o repasse é a única coisa que o componente faz.) */
type Props = { value: string; [attribute: string]: unknown };

export function GuardedInput({ value, ...props }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const input = ref.current!;
    if (document.activeElement !== input && input.value !== value) input.value = value;
  });
  return <input ref={ref} defaultValue={value} {...(props as object)} />;
}
