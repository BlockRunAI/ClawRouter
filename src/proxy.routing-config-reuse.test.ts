import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy } from "./proxy.js";
import { DEFAULT_ROUTING_CONFIG } from "./router/index.js";

describe("startProxy routing config reuse", () => {
  it("applies custom routing config when reusing an existing proxy", async () => {
    const walletKey = generatePrivateKey();
    const port = 21000 + Math.floor(Math.random() * 10000);

    // Start the first proxy (uses DEFAULT_ROUTING_CONFIG)
    const firstProxy = await startProxy({
      wallet: walletKey,
      port,
      skipBalanceCheck: true,
    });

    try {
      // Verify initial config is the default
      const initialRes = await fetch(`${firstProxy.baseUrl}/__routing-config`);
      expect(initialRes.status).toBe(200);
      const initialConfig = await initialRes.json();
      expect(initialConfig.version).toBe(DEFAULT_ROUTING_CONFIG.version);

      // Custom routing config with a modified tier
      const customConfig: Parameters<typeof startProxy>[0]["routingConfig"] = {
        tiers: {
          SIMPLE: { primary: "test-model-simple", fallback: ["test-fallback-1"] },
        } as Record<string, { primary: string; fallback: string[] }>,
      };

      // Start proxy again on same port — enters reuse path
      const secondProxy = await startProxy({
        wallet: walletKey,
        port,
        skipBalanceCheck: true,
        routingConfig: customConfig,
      });

      // The second proxy's close is a no-op (reuse path)
      await secondProxy.close();

      // Verify the routing config was updated on the running proxy
      const updatedRes = await fetch(`${firstProxy.baseUrl}/__routing-config`);
      expect(updatedRes.status).toBe(200);
      const updatedConfig = await updatedRes.json();
      expect(updatedConfig.tiers.SIMPLE.primary).toBe("test-model-simple");
      expect(updatedConfig.tiers.SIMPLE.fallback).toEqual(["test-fallback-1"]);

      // Other tiers should still have defaults (merged, not replaced)
      expect(updatedConfig.tiers.COMPLEX.primary).toBe(
        DEFAULT_ROUTING_CONFIG.tiers.COMPLEX.primary,
      );
    } finally {
      await firstProxy.close();
    }
  });

  it("leaves default routing config when reusing without routingConfig option", async () => {
    const walletKey = generatePrivateKey();
    const port = 21000 + Math.floor(Math.random() * 10000);

    const firstProxy = await startProxy({
      wallet: walletKey,
      port,
      skipBalanceCheck: true,
    });

    try {
      // Reuse without routingConfig
      const secondProxy = await startProxy({
        wallet: walletKey,
        port,
        skipBalanceCheck: true,
      });
      await secondProxy.close();

      // Config should still be the default
      const res = await fetch(`${firstProxy.baseUrl}/__routing-config`);
      expect(res.status).toBe(200);
      const config = await res.json();
      expect(config.version).toBe(DEFAULT_ROUTING_CONFIG.version);
      expect(config.tiers).toEqual(DEFAULT_ROUTING_CONFIG.tiers);
    } finally {
      await firstProxy.close();
    }
  });
});
