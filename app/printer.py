"""
Manda o PDF pra fila CUPS já compartilhada na rede.
Precisa do pacote `cups-client` instalado (já está no Dockerfile).
"""
import os
import subprocess

CUPS_HOST = os.environ.get("CUPS_HOST")          # ex: "192.168.0.10:631"
PRINTER_QUEUE = os.environ.get("PRINTER_QUEUE")  # nome da fila no CUPS

TIMEOUT = int(os.environ.get("PRINT_TIMEOUT_SECONDS", "60"))

# Opções passadas ao lp como `-o chave=valor`, separadas por espaço.
#
# `print-scaling=none` é a mais importante e não deve sair daqui: sem ela a
# impressora "ajusta à página" por conta própria e encolhe a folha uns 4%,
# fazendo as cartas saírem fora dos 63x88 mm. É o erro mais comum de proxy.
# `media=a4` evita que ela assuma Carta e reposicione tudo.
# Os nomes abaixo são os do PPD da fila (`lpoptions -p FILA -l`), não os
# nomes IPP genéricos — uma fila criada com `-m everywhere` usa PageSize /
# MediaType / cupsPrintQuality, e opção com nome errado é ignorada CALADA.
# Qualquer mudança aqui exige conferir os nomes reais da fila em uso.
#
# `PageSize=A4` é obrigatório: o padrão da EPSON L4260 é Letter, então sem
#   isso a folha inteira sai reposicionada.
#   NÃO use A4.Borderless — impressão sem margem amplia a imagem uns 2-3%
#   pra garantir sangria, e é justamente isso que tira a carta dos 63x88 mm.
# `print-scaling=none` não é do PPD, é atributo do CUPS (filtro pdftopdf) —
#   impede o "ajustar à página", que encolhe a folha uns 4%.
LP_OPTIONS = os.environ.get(
    "LP_OPTIONS",
    "print-scaling=none PageSize=A4 MediaType=Photographic "
    "cupsPrintQuality=High ColorModel=RGB",
)


def _lp_options() -> list[str]:
    args = []
    for opt in LP_OPTIONS.split():
        args += ["-o", opt]
    return args


class PrintError(RuntimeError):
    """O `lp` recusou o trabalho. NÃO pode ser engolida: quem clicou em
    Imprimir precisa saber que o papel não vai sair."""


def _hint(stderr: str) -> str:
    """Traduz os erros mais comuns do lp num próximo passo concreto."""
    err = stderr.lower()
    if "scheduler is not running" in err:
        alvo = CUPS_HOST or "socket local do CUPS"
        return (f"Não tem ninguém atendendo em {alvo}. Ou o cupsd não está no ar, "
                f"ou está escutando só em localhost (é o padrão do CUPS). No "
                f"servidor: `systemctl status cups` e `ss -lntp | grep 631`.")
    if "does not exist" in err:
        return (f'A fila "{PRINTER_QUEUE}" não existe nesse CUPS. Veja os nomes '
                f'reais em GET /admin/printers e ajuste PRINTER_QUEUE no .env.')
    if "forbidden" in err or "not authorized" in err or "unauthorized" in err:
        return (f"O CUPS em {CUPS_HOST} recusou a conexão por permissão. Libere o "
                f"IP do container em /etc/cups/cupsd.conf (Allow) e reinicie o cupsd.")
    if "connection refused" in err or "unable to connect" in err or "no route" in err:
        return (f"Não deu pra falar com o CUPS em {CUPS_HOST}. Confira se o "
                f"endereço está certo e se o container alcança essa rede.")
    return ""


def list_queues() -> dict:
    """
    Lista as filas que esse CUPS conhece — pra descobrir o nome certo.

    Sem CUPS_HOST o lpstat fala pelo socket local do CUPS, que é o caminho
    quando o container roda na mesma máquina da impressora e monta
    /run/cups/cups.sock. Por isso o CUPS_HOST vazio não é erro aqui.
    """
    cmd = ["lpstat"] + (["-h", CUPS_HOST] if CUPS_HOST else []) + ["-a"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
    except FileNotFoundError:
        return {"erro": "comando `lpstat` não encontrado (falta o pacote cups-client)."}
    except subprocess.TimeoutExpired:
        return {"erro": f"o CUPS em {CUPS_HOST or 'socket local'} "
                        f"não respondeu em {TIMEOUT}s."}

    filas = [linha.split()[0] for linha in r.stdout.splitlines() if linha.strip()]
    erro = r.stderr.strip() or None
    return {
        "cups_host": CUPS_HOST or "(socket local)",
        "printer_queue_configurada": PRINTER_QUEUE,
        "configurada_existe": PRINTER_QUEUE in filas if PRINTER_QUEUE else False,
        "filas": filas,
        "saida_bruta": r.stdout.strip(),
        "erro": erro,
        "dica": _hint(erro) or None if erro else None,
    }


def print_pdf(pdf_path: str) -> str:
    """
    Manda o PDF pra fila. Devolve uma frase curta com o que aconteceu, e
    levanta PrintError se o lp falhar.
    """
    if not PRINTER_QUEUE:
        msg = "PRINTER_QUEUE não configurada — impressão automática desligada."
        print(f"[printer] {msg}")
        return msg

    cmd = ["lp"]
    if CUPS_HOST:
        cmd += ["-h", CUPS_HOST]
    cmd += ["-d", PRINTER_QUEUE] + _lp_options() + [pdf_path]

    try:
        r = subprocess.run(cmd, check=True, capture_output=True, text=True,
                           timeout=TIMEOUT)
    except FileNotFoundError:
        raise PrintError("comando `lp` não encontrado no container "
                         "(falta o pacote cups-client).")
    except subprocess.TimeoutExpired:
        raise PrintError(f"o CUPS em {CUPS_HOST} não respondeu em {TIMEOUT}s.")
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or "").strip() or (e.stdout or "").strip()
        print(f"[printer] falha ao imprimir: {stderr}")
        hint = _hint(stderr)
        raise PrintError(f"{stderr or 'o lp saiu com erro'}{' ' + hint if hint else ''}")

    saida = (r.stdout or "").strip()
    print(f"[printer] {saida or 'enviado pra fila ' + PRINTER_QUEUE}")
    return saida or f"enviado pra fila {PRINTER_QUEUE}"
