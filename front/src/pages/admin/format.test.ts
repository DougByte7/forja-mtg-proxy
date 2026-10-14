import { decimal, fieldDecimal, fineMoney, int, money, when } from "./format";

describe("format", () => {
  it("dinheiro", () => {
    expect(money(12.5)).toBe("R$ 12,50");
    expect(money(0)).toBe("R$ 0,00");
    expect(fineMoney(0.1234)).toBe("R$ 0,123");
    expect(fineMoney(2)).toBe("R$ 2,00");
  });

  it("números", () => {
    expect(int(1234)).toBe("1.234");
    expect(decimal(1.23456)).toBe("1,235");
    expect(fieldDecimal(0.25)).toBe("0,25");
    expect(fieldDecimal(1.000049)).toBe("1");
    expect(fieldDecimal(0)).toBe("");
  });

  it("quando", () => {
    const now = Date.UTC(2026, 9, 14, 12, 0) ;
    const at = (msAgo: number) => (now - msAgo) / 1000;
    expect(when(null, now)).toBe("—");
    expect(when(at(10_000), now)).toMatch(/\(agora\)$/);
    expect(when(at(5 * 60_000), now)).toMatch(/\(há 5 min\)$/);
    expect(when(at(3 * 3_600_000), now)).toMatch(/\(há 3 h\)$/);
    expect(when(at(2 * 86_400_000), now)).toMatch(/\(há 2 d\)$/);
  });
});
