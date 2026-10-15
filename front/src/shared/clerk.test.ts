import { frontendApi } from "./clerk";

describe("frontendApi", () => {
  it("tira o domínio de dentro da chave publicável", () => {
    const key = "pk_test_" + btoa("forja-gato-12.clerk.accounts.dev$");
    expect(frontendApi(key)).toBe("forja-gato-12.clerk.accounts.dev");
  });

  it("aceita a chave sem o preenchimento do base64", () => {
    const key = "pk_live_" + btoa("clerk.forja.app$").replace(/=+$/, "");
    expect(frontendApi(key)).toBe("clerk.forja.app");
  });
});
