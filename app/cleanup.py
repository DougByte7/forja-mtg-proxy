"""
Limpeza automática dos PDFs antigos em PDF_OUTPUT_DIR.

Os PDFs ficam em cache no disco pra que "Ver PDF" e "Imprimir" usem
exatamente o mesmo arquivo (ver fulfillment.ensure_pdf). Como nada nunca
apagava esses arquivos, o volume só crescia.

A regra é por idade do arquivo, não por status do pedido, porque **apagar é
sempre reversível**: o `xml_text` continua guardado no banco pra sempre, e
abrir o link "Ver PDF" ou "Imprimir" de um pedido antigo simplesmente monta
a folha de novo. O único custo é baixar as imagens do Drive outra vez.

Só toca em arquivos com cara de folha montada (`pedido-XXXX.pdf`,
`combo-XXXX.pdf` e o marcador `.incompleto` que anda junto). O `orders.db`
mora na mesma pasta e não pode ser tocado de jeito nenhum — daí os regexes
fechados abaixo.
"""
import os
import re
import threading
import time

from . import pdf_generator

# Dias que um PDF fica no disco depois de gerado. 0 desliga a limpeza.
PDF_KEEP_DAYS = float(os.environ.get("PDF_KEEP_DAYS", "30"))
# De quanto em quanto tempo a faxina roda.
CLEANUP_INTERVAL_HOURS = float(os.environ.get("CLEANUP_INTERVAL_HOURS", "24"))

# `combo-` são as folhas combinadas (vários pedidos num papel só). Apagar
# também é reversível ali: o combo continua no banco e a folha se remonta.
_PDF_RE = re.compile(r"^(pedido|combo)-[A-Za-z0-9_-]+\.pdf$")
_MARKER_RE = re.compile(r"^(pedido|combo)-[A-Za-z0-9_-]+\.pdf\.incompleto$")


def _is_ours(name: str) -> bool:
    return bool(_PDF_RE.match(name) or _MARKER_RE.match(name))


def _podar_sessoes() -> int:
    """Sessões vencidas, na carona da faxina que já existe.

    Fica aqui, e não num laço próprio, porque é a mesma natureza de trabalho —
    apagar o que venceu — e uma thread a mais pra rodar uma vez por dia seria
    maquinário sem serventia. Nunca levanta: faxina que derruba o processo é
    pior do que sujeira.
    """
    try:
        from . import usuarios
        return usuarios.podar_sessoes()
    except Exception as e:
        print(f"[cleanup] não consegui podar as sessões: {e}")
        return 0


def run_once() -> dict:
    """Apaga os PDFs mais velhos que PDF_KEEP_DAYS. Devolve um resuminho."""
    sessoes = _podar_sessoes()
    if PDF_KEEP_DAYS <= 0:
        return {"desligado": True, "removidos": 0, "liberado_mb": 0.0,
                "sessoes_podadas": sessoes}

    directory = pdf_generator.OUTPUT_DIR
    if not os.path.isdir(directory):
        return {"removidos": 0, "liberado_mb": 0.0, "mantidos": 0,
                "sessoes_podadas": sessoes}

    cutoff = time.time() - PDF_KEEP_DAYS * 86400
    removed, freed, kept = 0, 0, 0

    for name in os.listdir(directory):
        if not _is_ours(name):
            continue
        path = os.path.join(directory, name)
        try:
            st = os.stat(path)
            if st.st_mtime >= cutoff:
                kept += 1
                continue
            size = st.st_size
            os.remove(path)
            removed += 1
            freed += size
        except FileNotFoundError:
            continue
        except OSError as e:
            print(f"[cleanup] não consegui apagar {name}: {e}")

    return {"removidos": removed,
            "liberado_mb": round(freed / (1024 * 1024), 2),
            "mantidos": kept,
            "sessoes_podadas": sessoes}


def _loop():
    while True:
        try:
            r = run_once()
            if r.get("removidos"):
                print(f"[cleanup] {r['removidos']} PDF(s) com mais de "
                      f"{PDF_KEEP_DAYS:g} dias apagados, "
                      f"{r['liberado_mb']} MB liberados.")
        except Exception as e:
            print(f"[cleanup] erro: {e}")
        time.sleep(CLEANUP_INTERVAL_HOURS * 3600)


def start_background():
    if PDF_KEEP_DAYS <= 0:
        print("[cleanup] PDF_KEEP_DAYS=0 — limpeza automática desligada.")
        return
    print(f"[cleanup] ligada: apaga PDF com mais de {PDF_KEEP_DAYS:g} dias, "
          f"a cada {CLEANUP_INTERVAL_HOURS:g}h.")
    threading.Thread(target=_loop, daemon=True).start()
