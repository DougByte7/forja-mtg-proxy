import { workerWarning } from "./worker";

describe("workerWarning", () => {
  const now = 1_000_000_000;
  const worker = (ago: number | null) =>
    ({ visto_em: ago == null ? null : now / 1000 - ago, offline_segundos: 120 });

  it("nunca deu sinal", () =>
    expect(workerWarning({ worker: worker(null) }, now)).toMatch(/nunca deu sinal/));
  it("sem worker nenhum na sessão", () =>
    expect(workerWarning({ worker: null }, now)).toMatch(/nunca deu sinal/));
  it("sumiu", () =>
    expect(workerWarning({ worker: worker(600), impressora: "fila" }, now)).toMatch(/não dá sinal desde/));
  it("no ar, sem fila de impressão", () =>
    expect(workerWarning({ worker: worker(10), impressora: null }, now)).toMatch(/sem PRINTER_QUEUE/));
  it("tudo certo, nada a dizer", () =>
    expect(workerWarning({ worker: worker(10), impressora: "fila" }, now)).toBe(""));
});
