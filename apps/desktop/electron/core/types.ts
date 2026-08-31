export type AgentId = "openclaw" | "codex" | "hermes" | "dsh" | "pi";

export type ActivationMode = "immediate" | "restart-agent" | "restart-gateway";

export type PaymentChain = "base" | "solana";

export type AgentHealth = "not-installed" | "ready" | "needs-attention" | "checking";

export type AgentStatus = {
  id: AgentId;
  name: string;
  description: string;
  installed: boolean;
  configured: boolean;
  proxyReachable: boolean;
  health: AgentHealth;
  activation: ActivationMode;
  restartRequired: boolean;
  removalMode: "restore" | "disconnect" | "unavailable";
  details: string[];
};

export type InstallOptions = {
  setDefault?: boolean;
  model?: string;
};

export type OperationResult = {
  ok: boolean;
  status: AgentStatus;
  message: string;
  rolledBack?: boolean;
};

export type ModelInfo = {
  id: string;
  name?: string;
  ownedBy?: string;
  contextWindow?: number;
  maxOutput?: number;
  inputPrice?: number;
  outputPrice?: number;
  reasoning?: boolean;
  vision?: boolean;
  agentic?: boolean;
  toolCalling?: boolean;
};

export type DashboardData = {
  proxy: {
    reachable: boolean;
    status?: string;
    wallet?: string;
    activeWallet?: string;
    solana?: string;
    paymentChain?: string;
    configuredChain?: PaymentChain;
    chainRestartRequired?: boolean;
    balance?: number;
    balances?: Partial<Record<PaymentChain, number>>;
    nativeBalances?: Partial<Record<PaymentChain, number>>;
    walletRestartRequired?: boolean;
    error?: string;
  };
  stats: Record<string, unknown> | null;
  models: ModelInfo[];
};

export type PaymentChainSwitchResult = {
  ok: boolean;
  chain: PaymentChain;
  restartRequired: boolean;
  message: string;
};

export type OnrampResult = {
  ok: boolean;
  message: string;
  url?: string;
};

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<CommandResult>;

export type AdapterContext = {
  homeDir: string;
  stateDir: string;
  proxyBaseUrl: string;
  runCommand: CommandRunner;
  commandExists: (command: string) => Promise<boolean>;
  fetch: typeof globalThis.fetch;
};

export interface AgentAdapter {
  readonly id: AgentId;
  readonly name: string;
  readonly description: string;
  readonly activation: ActivationMode;
  managedPaths(context: AdapterContext): string[];
  status(context: AdapterContext): Promise<AgentStatus>;
  install(context: AdapterContext, options: InstallOptions): Promise<void>;
  disconnect?(context: AdapterContext): Promise<void>;
  verify(context: AdapterContext): Promise<{ ok: boolean; details: string[] }>;
}
