import { followQueue, queueResult } from "./queue";
import type { QueueState } from "./types";

describe("followQueue", () => {
  it("lê até sair da fila, avisando cada passo", async () => {
    const states: QueueState[] = [
      { status: "a_imprimir" }, { status: "imprimindo" }, { status: "impresso", impressao_msg: "ok" },
    ];
    const steps: string[] = [];
    const r = await followQueue(async () => states.shift()!, (s) => steps.push(s.status),
                                { wait: async () => {} });
    expect(r.status).toBe("impresso");
    expect(steps).toEqual(["a_imprimir", "imprimindo"]);
  });

  it("desiste no teto e devolve o que estiver", async () => {
    let t = 0;
    const r = await followQueue(async () => ({ status: "a_imprimir" as const }), () => {},
      { maxMinutes: 1, wait: async () => { t += 30_000; }, now: () => t });
    expect(r.status).toBe("a_imprimir");
    expect(t).toBe(60_000);
  });
});

describe("queueResult", () => {
  it.each([
    [{ status: "impresso", impressao_msg: "job 12" }, "ok", "job 12"],
    [{ status: "impresso", impressao_falhas: 2 }, "erro", "ATENÇÃO: 2 carta(s)"],
    [{ status: "erro_impressao", impressao_msg: "sem papel" }, "erro", "A impressora recusou: sem papel"],
    [{ status: "imprimindo" }, "andando", "Continua na fila"],
    [{ status: "notified" }, "erro", "Saiu da fila sem imprimir (Avisou que pagou)"],
  ] as const)("%o", (state, kind, text) => {
    const r = queueResult(state as QueueState);
    expect(r.kind).toBe(kind);
    expect(r.text).toContain(text);
  });
});
