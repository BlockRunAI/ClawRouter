import { describe, expect, it } from "vitest";
import { healthLabel, paymentSummary, walletActivity } from "../src/connection-state";
import type { AgentStatus, DashboardData } from "../electron/core/types";

const agent: AgentStatus = {
  id: "codex",
  name: "Codex",
  description: "",
  installed: true,
  configured: true,
  health: "ready",
  activation: "restart-agent",
  restartRequired: true,
  proxyReachable: true,
  removalMode: "restore",
  details: [],
};
const proxy: DashboardData["proxy"] = {
  reachable: true,
  configuredChain: "solana",
  paymentChain: "solana",
  configuredSolana: "fixture-wallet",
  activeSolana: "fixture-wallet",
};

describe("truthful connection state", () => {
  it("does not claim a pending-restart agent is connected", () => {
    expect(healthLabel(agent)).toBe("Configured · restart required");
  });
  it("reports ready immediate and restarted agents as connected", () => {
    expect(healthLabel({ ...agent, restartRequired: false })).toBe("Connected");
  });
  it("does not call a missing CLI connected", () => {
    expect(healthLabel({ ...agent, installed: false })).toBe("Configured · CLI missing");
  });
  it("distinguishes checking and unreachable states", () => {
    expect(healthLabel({ ...agent, health: "checking" })).toBe("Checking…");
    expect(healthLabel({ ...agent, restartRequired: false, health: "needs-attention" })).toBe(
      "Needs proxy",
    );
  });
  it("describes API key payment without claiming a blockchain", () => {
    expect(paymentSummary({ ...proxy, authMode: "api-key" })).toBe("paying with API key");
  });
  it("uses the running chain, not the pending configured chain", () => {
    expect(paymentSummary({ ...proxy, paymentChain: "base", chainRestartRequired: true })).toBe(
      "settling on Base · restart to apply network change",
    );
  });
  it("does not guess a network or live status", () => {
    expect(paymentSummary({ reachable: true })).toBe("payment network not confirmed");
    expect(paymentSummary({ reachable: false })).toBe("Router offline");
  });
  it("only marks the verified running wallet active", () => {
    expect(walletActivity(proxy, "solana").active).toBe(true);
  });
  it.each([
    { walletRestartChains: ["solana"] },
    { walletRestartRequired: true },
    { activeSolana: "old-fixture" },
    { chainRestartRequired: true },
    { paymentChain: "base" },
    { reachable: false },
    { activeSolana: undefined },
    { authMode: "api-key" },
  ] as Partial<DashboardData["proxy"]>[])(
    "does not claim pending, inactive, or unknown wallet is active: %j",
    (change) => {
      expect(walletActivity({ ...proxy, ...change }, "solana").active).toBe(false);
    },
  );
});
