"""
Diagnóstico da rede do container: descobre ONDE o download do Drive trava.

Precisa rodar de dentro do container, que é o ponto de vista que interessa:
a rede vista de fora, no host, não é a mesma.

    docker compose exec -T forja-backend python - < diag_rede.py

Não precisa rebuildar a imagem: o script vai por stdin e só usa `requests`,
que já está instalado. Pra testar outros ids, passe como argumento (aí use
`docker compose cp` em vez do stdin).
"""
import os, socket, sys, time
from concurrent.futures import ThreadPoolExecutor

import requests
import urllib3.util.connection as u3conn

HOST = "drive.usercontent.google.com"
IDS = sys.argv[1:] or ["1MP0Nd_Ajtda4txguw-wHAtIYhS_otiDL",
                       "1FTnnFMkteErtoxqwzvOCS--6BfuO2oVp",
                       "1rUpNpfNLRvsMYdFP_vt4tcDQOweIh89d",
                       "1oVU1L1P5DUijkwbQjv61QV1FRZ8775Up"]
URL = "https://drive.usercontent.google.com/download?id={}&export=download&confirm=t"


def secao(t):
    print(f"\n=== {t} ===", flush=True)


secao("1. MTU das interfaces do container")
base = "/sys/class/net"
for n in sorted(os.listdir(base)):
    try:
        mtu = open(f"{base}/{n}/mtu").read().strip()
        print(f"  {n}: mtu={mtu}")
    except OSError:
        pass
print("  (eth0 com mtu 1500 num link que na verdade é menor = buraco de PMTU)")

secao("2. DNS: quais endereços o container resolve")
try:
    infos = socket.getaddrinfo(HOST, 443, proto=socket.IPPROTO_TCP)
    v4 = sorted({i[4][0] for i in infos if i[0] == socket.AF_INET})
    v6 = sorted({i[4][0] for i in infos if i[0] == socket.AF_INET6})
    print(f"  IPv4: {v4 or '(nenhum)'}")
    print(f"  IPv6: {v6 or '(nenhum)'}")
    print(f"  Python tentaria primeiro: {infos[0][4][0]}")
except Exception as e:
    print(f"  FALHOU: {e}")


def baixa(drive_id, rotulo, read_timeout=20):
    """Baixa medindo o MAIOR intervalo sem receber byte nenhum."""
    t0 = time.monotonic()
    total = 0
    maior_gap = 0.0
    ultimo = t0
    try:
        with requests.get(URL.format(drive_id), stream=True,
                          timeout=(15, read_timeout)) as r:
            cabecalho = time.monotonic() - t0
            r.raise_for_status()
            for chunk in r.iter_content(64 * 1024):
                agora = time.monotonic()
                maior_gap = max(maior_gap, agora - ultimo)
                ultimo = agora
                total += len(chunk)
        dt = time.monotonic() - t0
        print(f"  [{rotulo}] OK {total/1e6:.1f} MB em {dt:.1f}s "
              f"({total/dt/1e6:.1f} MB/s) | cabeçalho {cabecalho:.1f}s | "
              f"maior pausa {maior_gap:.1f}s", flush=True)
        return True
    except Exception as e:
        dt = time.monotonic() - t0
        print(f"  [{rotulo}] TRAVOU após {total/1e6:.1f} MB em {dt:.1f}s | "
              f"maior pausa {maior_gap:.1f}s | {type(e).__name__}: {e}", flush=True)
        return False


secao("3. Uma imagem, sozinha (sem paralelismo)")
baixa(IDS[0], "sequencial")

secao("4. Uma imagem, forçando IPv4")
_orig = u3conn.allowed_gai_family
u3conn.allowed_gai_family = lambda: socket.AF_INET
baixa(IDS[0], "só IPv4")
u3conn.allowed_gai_family = _orig

secao(f"5. {len(IDS)} imagens em paralelo (o que o gerador faz hoje)")
t0 = time.monotonic()
with ThreadPoolExecutor(max_workers=len(IDS)) as pool:
    oks = list(pool.map(lambda d: baixa(d, d[:12]), IDS))
print(f"  -> {sum(oks)}/{len(IDS)} deram certo em {time.monotonic()-t0:.1f}s")

secao("Como ler")
print("""  - Travou em TODOS, inclusive sozinho  -> rede da máquina/uplink (veja
    se o cloudflared reclama junto). Não é o Drive nem o gerador.
  - Só IPv4 funciona e o normal trava     -> IPv6 quebrado no container.
  - Sozinho vai bem, paralelo trava       -> link saturando: baixe DRIVE_WORKERS.
  - 'maior pausa' alta (>10s) com pouca   -> perda de pacote / buraco de PMTU.
    coisa baixada""")
