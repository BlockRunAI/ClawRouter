/**
 * The Solana payment signer must honour CLAWROUTER_SOLANA_RPC_URL.
 *
 * Signing a Solana x402 payment is not local the way EIP-3009 is: the
 * exact-SVM client reads the asset's mint account over RPC first, defaulting to
 * the public api.mainnet-beta.solana.com. Hosts that cannot reach that endpoint
 * failed every paid Solana call with a bare "fetch failed" and had no way to
 * point signing elsewhere — the env var existed but reached only the balance
 * monitor (ClawRouter-Hermes#38).
 *
 * `registerExactSvmScheme` constructs its schemes from the signer alone, so the
 * override is applied by re-registering rpc-aware instances over the helper's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";

const registerExactSvmScheme = vi.fn();
const svmSchemeConfigs: unknown[] = [];
const svmV1SchemeConfigs: unknown[] = [];

vi.mock("@x402/svm/exact/client", () => ({
  registerExactSvmScheme,
  ExactSvmScheme: class {
    scheme = "exact";
    constructor(_signer: unknown, config?: unknown) {
      svmSchemeConfigs.push(config);
    }
  },
}));

vi.mock("@x402/svm/v1", () => ({
  NETWORKS: ["solana", "solana-devnet"],
  ExactSvmSchemeV1: class {
    scheme = "exact";
    constructor(_signer: unknown, config?: unknown) {
      svmV1SchemeConfigs.push(config);
    }
  },
}));

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

const originalRpcUrl = process.env.CLAWROUTER_SOLANA_RPC_URL;

async function startSolanaProxy() {
  const { startProxy } = await import("./proxy.js");
  const { deriveSolanaKeyBytes } = await import("./wallet.js");
  return startProxy({
    wallet: {
      key: generatePrivateKey(),
      solanaPrivateKeyBytes: deriveSolanaKeyBytes(TEST_MNEMONIC),
    },
    paymentChain: "solana",
    port: 22000 + Math.floor(Math.random() * 1000),
    skipBalanceCheck: true,
  });
}

describe("Solana payment signing RPC override", () => {
  beforeEach(() => {
    registerExactSvmScheme.mockClear();
    svmSchemeConfigs.length = 0;
    svmV1SchemeConfigs.length = 0;
  });

  afterEach(() => {
    if (originalRpcUrl === undefined) {
      delete process.env.CLAWROUTER_SOLANA_RPC_URL;
    } else {
      process.env.CLAWROUTER_SOLANA_RPC_URL = originalRpcUrl;
    }
  });

  it("signs against CLAWROUTER_SOLANA_RPC_URL when it is set", async () => {
    process.env.CLAWROUTER_SOLANA_RPC_URL = "https://rpc.example.test";

    const proxy = await startSolanaProxy();
    try {
      expect(svmSchemeConfigs).toEqual([{ rpcUrl: "https://rpc.example.test" }]);
      // Both v1 compat networks re-registered with the same endpoint.
      expect(svmV1SchemeConfigs).toEqual([
        { rpcUrl: "https://rpc.example.test" },
        { rpcUrl: "https://rpc.example.test" },
      ]);
    } finally {
      await proxy.close();
    }
  });

  it("leaves the library default in place when the override is unset", async () => {
    delete process.env.CLAWROUTER_SOLANA_RPC_URL;

    const proxy = await startSolanaProxy();
    try {
      expect(registerExactSvmScheme).toHaveBeenCalledTimes(1);
      expect(registerExactSvmScheme.mock.calls[0][1].signer).toBeDefined();
      expect(svmSchemeConfigs).toEqual([]);
      expect(svmV1SchemeConfigs).toEqual([]);
    } finally {
      await proxy.close();
    }
  });
});
