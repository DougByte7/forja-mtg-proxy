/* O menu aberto (ver `popupMenu.ts`). Posiciona depois de medir: um menu de
   12 categorias perto do rodapé abriria pra fora da tela, e aí a metade de
   baixo dele é inalcançável. */
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { closeMenu, popupMenu, type MenuItem } from "../popupMenu";
import { SpriteIcon } from "./SpriteIcon";

function Item({ item }: { item: MenuItem }) {
  if (item === "sep") return <div class="separador" />;
  if ("title" in item) return <h4>{item.title}</h4>;
  if ("note" in item) return <p class="nota-menu">{item.note}</p>;
  const body = (
    <>
      <span class="marca">{item.icon && <SpriteIcon name={item.icon} />}</span>
      <span class="rot-menu">{item.label}</span>
    </>
  );
  const click = (e: MouseEvent) => {
    closeMenu();
    item.onClick?.(e);
  };
  return item.href
    ? <a href={item.href} role="menuitem" class={item.cls || ""} onClick={click}>{body}</a>
    : <button type="button" role="menuitem" class={item.cls || ""} disabled={item.disabled} onClick={click}>{body}</button>;
}

export function PopupMenu() {
  const menu = popupMenu.value;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !menu) return;
    const box = menu.anchor, m = el.getBoundingClientRect();
    const x = Math.min(box.left, window.innerWidth - m.width - 8);
    const y = box.bottom + m.height + 8 > window.innerHeight ? Math.max(8, box.top - m.height - 4) : box.bottom + 4;
    el.style.left = Math.max(8, x) + "px";
    el.style.top = y + "px";
    el.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus();
  }, [menu]);
  // Apertar fora fecha. No `pointerdown`, e não no clique: o clique num
  // botão que abre OUTRO menu (ou o clique direito noutra linha) chega
  // depois, e abre o dele por cima.
  useEffect(() => {
    if (!menu) return;
    const outside = (e: Event) => { if (!ref.current?.contains(e.target as Node)) closeMenu(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);
  if (!menu) return null;
  return <div class="menu" role="menu" ref={ref}>{menu.items.map((item) => <Item item={item} />)}</div>;
}
