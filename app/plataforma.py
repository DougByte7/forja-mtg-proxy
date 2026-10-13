"""
Onde o site está rodando, pra escolher os PADRÕES certos de cada lugar.

O mesmo código roda em dois lugares muito diferentes:

* **homelab** (container): um processo que vive dias, com disco que
  sobrevive ao restart, atrás do túnel da Cloudflare;
* **Vercel**: cada requisição pode cair num processo novo, o disco só deixa
  escrever em `/tmp` e some com o processo, e quem está na frente é ela.

A Vercel põe `VERCEL=1` no ambiente de todo deploy, sozinha. Os módulos usam
`padrao(homelab, vercel)` no lugar do valor fixo, e assim um deploy novo na
Vercel já nasce configurado certo — sem depender de lembrar meia dúzia de
variáveis (e a Vercel nem aceita variável com valor vazio, que é como se
desliga o log em arquivo). Qualquer variável posta à mão continua mandando.
"""
import os

NA_VERCEL = os.environ.get("VERCEL") == "1"


def padrao(homelab: str, vercel: str) -> str:
    return vercel if NA_VERCEL else homelab
