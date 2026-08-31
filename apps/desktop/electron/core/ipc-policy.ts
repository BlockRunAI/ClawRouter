import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import type { AgentId, InstallOptions, PaymentChain } from "./types.js";

const AGENT_IDS = new Set<AgentId>(["openclaw", "codex", "hermes", "dsh", "pi"]);
const EXTERNAL_HOSTS = new Set(["github.com", "pay.coinbase.com"]);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,199}$/;

export function parseAgentId(value: unknown): AgentId {
  if (typeof value !== "string" || !AGENT_IDS.has(value as AgentId)) {
    throw new Error("Unsupported agent");
  }
  return value as AgentId;
}

export function parseInstallOptions(value: unknown): InstallOptions {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid install options");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "setDefault" && key !== "model")) {
    throw new Error("Unknown install option");
  }
  if (input.setDefault !== undefined && typeof input.setDefault !== "boolean") {
    throw new Error("setDefault must be boolean");
  }
  if (
    input.model !== undefined &&
    (typeof input.model !== "string" || !MODEL_ID.test(input.model))
  ) {
    throw new Error("Invalid model id");
  }
  return {
    ...(input.setDefault === undefined ? {} : { setDefault: input.setDefault }),
    ...(input.model === undefined ? {} : { model: input.model as string }),
  };
}

export function parsePaymentChain(value: unknown): PaymentChain {
  if (value !== "base" && value !== "solana") throw new Error("Unsupported payment chain");
  return value;
}

export function parseOnrampAmount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 2_500) {
    throw new Error("Onramp amount must be between $1 and $2,500");
  }
  return Math.round(value * 100) / 100;
}

export function parseExternalUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid external URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid external URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !EXTERNAL_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error("External URL is not allowed");
  }
  return url.toString();
}

export function isTrustedRendererUrl(currentUrl: string, expectedFile: string): boolean {
  try {
    const url = new URL(currentUrl);
    if (url.protocol !== "file:" || url.search || url.hash) return false;
    return resolve(fileURLToPath(url)) === resolve(expectedFile);
  } catch {
    return false;
  }
}
