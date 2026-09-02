import type {
  ActivationMode,
  AdapterContext,
  AgentHealth,
  AgentId,
  AgentStatus,
} from "../core/types.js";
import { proxyHealth } from "../core/runtime.js";

export async function statusShape(input: {
  context: AdapterContext;
  id: AgentId;
  name: string;
  description: string;
  installed: boolean;
  configured: boolean;
  activation: ActivationMode;
  restartRequired?: boolean;
  details?: string[];
}): Promise<AgentStatus> {
  const proxyReachable = await proxyHealth(input.context);
  let health: AgentHealth = "not-installed";
  if (input.installed && input.configured && proxyReachable) health = "ready";
  else if (input.installed || input.configured) health = "needs-attention";
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    installed: input.installed,
    configured: input.configured,
    proxyReachable,
    health,
    activation: input.activation,
    restartRequired: input.restartRequired ?? false,
    removalMode: "unavailable",
    details: input.details ?? [],
  };
}

export function assertCommand(
  result: { code: number; stdout: string; stderr: string },
  label: string,
): void {
  if (result.code === 0) return;
  const detail = (result.stderr || result.stdout).trim().slice(-800);
  throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
}
