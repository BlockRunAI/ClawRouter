import type {
  AgentId,
  AgentStatus,
  DashboardData,
  InstallOptions,
  OperationResult,
  OnrampResult,
  PaymentChain,
  PaymentChainSwitchResult,
} from "../electron/core/types";

export type ClawRouterApi = {
  statuses(): Promise<AgentStatus[]>;
  install(agent: AgentId, options?: InstallOptions): Promise<OperationResult>;
  uninstall(agent: AgentId): Promise<OperationResult>;
  dashboard(): Promise<DashboardData>;
  switchPaymentChain(chain: PaymentChain): Promise<PaymentChainSwitchResult>;
  createOnramp(amount: number): Promise<OnrampResult>;
  openExternal(url: string): Promise<void>;
};

declare global {
  interface Window {
    clawrouter?: ClawRouterApi;
  }
}

const demoAgents: AgentStatus[] = [
  {
    id: "openclaw",
    name: "OpenClaw",
    description: "Native ClawRouter plugin with chat, tools, wallet, and smart routing.",
    installed: true,
    configured: true,
    proxyReachable: true,
    health: "ready",
    activation: "restart-gateway",
    restartRequired: false,
    removalMode: "disconnect",
    details: [],
  },
  {
    id: "codex",
    name: "Codex",
    description: "Responses API bridge for Codex CLI and Codex Desktop.",
    installed: true,
    configured: true,
    proxyReachable: true,
    health: "ready",
    activation: "restart-agent",
    restartRequired: true,
    removalMode: "restore",
    details: ["Restart Codex Desktop after changing the active provider."],
  },
  {
    id: "hermes",
    name: "Hermes",
    description: "Hermes model-provider plugin backed by the local ClawRouter proxy.",
    installed: true,
    configured: false,
    proxyReachable: true,
    health: "needs-attention",
    activation: "restart-agent",
    restartRequired: false,
    removalMode: "disconnect",
    details: [],
  },
  {
    id: "dsh",
    name: "DeepSeek Harness",
    description: "Official DSH provider configuration with hot-reload and no separate API key.",
    installed: false,
    configured: false,
    proxyReachable: true,
    health: "not-installed",
    activation: "immediate",
    restartRequired: false,
    removalMode: "unavailable",
    details: ["DSH settings are hot-reloaded.", "DSH is currently a developer preview."],
  },
  {
    id: "pi",
    name: "Pi",
    description: "Minimal terminal coding agent routed through the local ClawRouter catalog.",
    installed: true,
    configured: false,
    proxyReachable: true,
    health: "needs-attention",
    activation: "immediate",
    restartRequired: false,
    removalMode: "unavailable",
    details: [],
  },
];

const demoDashboard: DashboardData = {
  proxy: {
    reachable: true,
    status: "ok",
    wallet: "0x7c21…9a08",
    activeWallet: "0x7c21…9a08",
    solana: "Bv8m…2Kqa",
    paymentChain: "base",
    configuredChain: "base",
    balance: 18.42,
    balances: { base: 18.42, solana: 7.08 },
    nativeBalances: { base: 0.0034, solana: 0.18 },
  },
  stats: { requests: 284, totalCost: 3.82, savings: 21.14, inputTokens: 812400 },
  models: [
    {
      id: "auto",
      name: "Auto (Smart Router - Balanced)",
      ownedBy: "blockrun",
      contextWindow: 1_050_000,
      maxOutput: 128_000,
      inputPrice: 0,
      outputPrice: 0,
    },
    {
      id: "free/gpt-oss-120b",
      name: "[Free] GPT-OSS 120B",
      ownedBy: "free",
      contextWindow: 128_000,
      maxOutput: 16_384,
      inputPrice: 0,
      outputPrice: 0,
    },
    {
      id: "anthropic/claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      ownedBy: "anthropic",
      contextWindow: 200_000,
      maxOutput: 64_000,
      inputPrice: 3,
      outputPrice: 15,
      reasoning: true,
      vision: true,
      agentic: true,
      toolCalling: true,
    },
    {
      id: "openai/gpt-5.4",
      name: "GPT-5.4",
      ownedBy: "openai",
      contextWindow: 400_000,
      maxOutput: 128_000,
      inputPrice: 2.5,
      outputPrice: 15,
      reasoning: true,
      vision: true,
      agentic: true,
      toolCalling: true,
    },
    {
      id: "google/gemini-3.1-pro",
      name: "Gemini 3.1 Pro",
      ownedBy: "google",
      contextWindow: 1_050_000,
      maxOutput: 65_536,
      inputPrice: 2,
      outputPrice: 12,
      reasoning: true,
      vision: true,
      toolCalling: true,
    },
    {
      id: "deepseek/deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      ownedBy: "deepseek",
      contextWindow: 1_048_576,
      maxOutput: 65_536,
      inputPrice: 0.435,
      outputPrice: 0.87,
      reasoning: true,
      agentic: true,
      toolCalling: true,
    },
  ],
};

const fallbackApi: ClawRouterApi = {
  statuses: async () => demoAgents,
  dashboard: async () => demoDashboard,
  install: async (agent) => {
    const target = demoAgents.find((item) => item.id === agent)!;
    target.installed = true;
    target.configured = true;
    target.health = "ready";
    return { ok: true, status: target, message: `${target.name} is connected to ClawRouter.` };
  },
  uninstall: async (agent) => {
    const target = demoAgents.find((item) => item.id === agent)!;
    target.configured = false;
    target.health = "needs-attention";
    return { ok: true, status: target, message: `${target.name} configuration was restored.` };
  },
  switchPaymentChain: async (chain) => {
    demoDashboard.proxy.configuredChain = chain;
    demoDashboard.proxy.paymentChain = chain;
    demoDashboard.proxy.balance = demoDashboard.proxy.balances?.[chain];
    return { ok: true, chain, restartRequired: false, message: `${chain} selected.` };
  },
  createOnramp: async (amount) => ({
    ok: true,
    url: `https://pay.coinbase.com/buy/select-asset?sessionToken=demo&defaultAsset=USDC&defaultNetwork=base&presetFiatAmount=${amount}`,
    message: "Coinbase Onramp is ready.",
  }),
  openExternal: async () => undefined,
};

const desktopBridge = window.clawrouter;

export const api: ClawRouterApi = desktopBridge
  ? {
      ...desktopBridge,
      switchPaymentChain:
        desktopBridge.switchPaymentChain ??
        (async (chain) => ({
          ok: false,
          chain,
          restartRequired: false,
          message: "Wallet switching requires the latest ClawRouter Desktop runtime.",
        })),
      createOnramp:
        desktopBridge.createOnramp ??
        (async () => ({
          ok: false,
          message: "Fiat funding requires the latest ClawRouter Desktop runtime.",
        })),
    }
  : fallbackApi;
