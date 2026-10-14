/* A entrada do deckbuilder: a tela inteira é o `<App/>`, e o que vem da
   rede (a conta, o deck do link) chega depois, por `boot`. */
import { render } from "preact";
import { boot } from "./boot";
import { App } from "./ui/App";

render(<App />, document.getElementById("app")!);
boot();
