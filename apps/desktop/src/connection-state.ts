import type { AgentStatus, DashboardData, PaymentChain } from "../electron/core/types";

type Proxy = DashboardData["proxy"];

export function healthLabel(agent: AgentStatus): string {
  if (!agent.installed) return agent.configured ? "Configured · CLI missing" : "Not detected";
  if (agent.health === "checking") return "Checking…";
  if (agent.configured && agent.restartRequired) return "Configured · restart required";
  if (agent.health === "ready") return "Connected";
  return agent.configured ? "Needs proxy" : "Available";
}

export function paymentSummary(proxy?: Proxy): string {
  if (!proxy?.reachable) return "Router offline";
  if (proxy.authMode === "api-key") return "paying with API key";
  const chain = proxy.paymentChain;
  if (chain !== "base" && chain !== "solana") return "payment network not confirmed";
  return `settling on ${chain === "solana" ? "Solana" : "Base"}${proxy.chainRestartRequired ? " · restart to apply network change" : ""}`;
}

export function walletActivity(proxy: Proxy | undefined, chain: PaymentChain) {
  if (proxy?.authMode === "api-key") return { active: false, text: "Not used in API key mode" };
  if (!proxy?.reachable) return { active: false, text: "Router offline — wallet not active" };
  const configured =
    chain === "base"
      ? (proxy.configuredWallet ?? proxy.wallet)
      : (proxy.configuredSolana ?? proxy.solana);
  const running = chain === "base" ? proxy.activeWallet : proxy.activeSolana;
  if (
    proxy.chainRestartRequired ||
    proxy.walletRestartChains?.includes(chain) ||
    (proxy.walletRestartRequired && !proxy.walletRestartChains?.length) ||
    (configured && running && configured !== running)
  ) {
    return { active: false, text: "Restart ClawRouter to apply wallet or network changes" };
  }
  if (proxy.paymentChain !== chain || !configured || !running) {
    return { active: false, text: "Default wallet — active payment not confirmed" };
  }
  return { active: true, text: "Active — connected agents pay from this wallet" };
}
