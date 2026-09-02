import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  isTrustedRendererUrl,
  parseAgentId,
  parseExternalUrl,
  parseInstallOptions,
  parseOnrampAmount,
  parsePaymentChain,
} from "../electron/core/ipc-policy.js";

describe("desktop IPC policy", () => {
  it("accepts only declared agent and chain values", () => {
    expect(parseAgentId("codex")).toBe("codex");
    expect(parsePaymentChain("solana")).toBe("solana");
    expect(() => parseAgentId("../../config")).toThrow("Unsupported agent");
    expect(() => parsePaymentChain("ethereum")).toThrow("Unsupported payment chain");
  });

  it("accepts bounded fiat amounts", () => {
    expect(parseOnrampAmount(50)).toBe(50);
    expect(parseOnrampAmount(12.345)).toBe(12.35);
    expect(() => parseOnrampAmount(0)).toThrow();
    expect(() => parseOnrampAmount(2_501)).toThrow();
    expect(() => parseOnrampAmount("50")).toThrow();
  });

  it("accepts bounded model options and rejects injected or unknown fields", () => {
    expect(parseInstallOptions({ setDefault: true, model: "anthropic/claude-sonnet-4.6" })).toEqual(
      {
        setDefault: true,
        model: "anthropic/claude-sonnet-4.6",
      },
    );
    expect(() => parseInstallOptions({ model: "auto\nmodel_provider = 'evil'" })).toThrow(
      "Invalid model id",
    );
    expect(() => parseInstallOptions({ model: "x".repeat(201) })).toThrow("Invalid model id");
    expect(() => parseInstallOptions({ command: "rm" })).toThrow("Unknown install option");
  });

  it("opens only credential-free approved HTTPS links", () => {
    expect(parseExternalUrl("https://github.com/BlockRunAI/ClawRouter")).toBe(
      "https://github.com/BlockRunAI/ClawRouter",
    );
    expect(() => parseExternalUrl("https://example.com/")).toThrow();
    expect(
      parseExternalUrl("https://pay.coinbase.com/buy/select-asset?sessionToken=single-use"),
    ).toContain("pay.coinbase.com");
    expect(() => parseExternalUrl("https://pay.coinbase.com.evil.test/buy")).toThrow();
    expect(() => parseExternalUrl("https://user:pass@github.com/repo")).toThrow();
    expect(() => parseExternalUrl("file:///etc/passwd")).toThrow();
  });

  it("trusts only the exact packaged renderer file", () => {
    const expected = "/Applications/ClawRouter.app/Contents/Resources/app/dist/index.html";
    expect(isTrustedRendererUrl(pathToFileURL(expected).href, expected)).toBe(true);
    expect(isTrustedRendererUrl(`${pathToFileURL(expected).href}#remote`, expected)).toBe(false);
    expect(isTrustedRendererUrl("https://github.com/BlockRunAI/ClawRouter", expected)).toBe(false);
    expect(isTrustedRendererUrl(pathToFileURL("/tmp/other.html").href, expected)).toBe(false);
  });
});
