import { useEffect, useRef, useState } from "preact/hooks";

/** Retorno no próprio botão que a pessoa acabou de apertar — é onde ela está
    olhando. O rótulo vira o aviso por um instante e volta. */
export function useFlash(label: string, ms = 1800): [string, (message: string) => void] {
  const [text, setText] = useState(label);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [text, (message) => {
    setText(message);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setText(label), ms);
  }];
}
