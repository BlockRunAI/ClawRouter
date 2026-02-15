/**
 * Claw Credit payment backend for ClawRouter.
 *
 * Uses the official @t54-labs/clawcredit-sdk payment path so requests include
 * SDK-generated metadata and richer audit context.
 */

import { ClawCredit, withTrace } from "@t54-labs/clawcredit-sdk";

const DEFAULT_SERVICE_URL = "https://api.claw.credit";

export type ClawCreditConfig = {
  baseUrl?: string;
  apiToken: string;
  chain: string;
  asset: string;
  agent?: string;
  agentId?: string;
};

export type PreAuthParams = {
  estimatedAmount: string;
};

type SdkClient = {
  pay: (args: {
    transaction: {
      recipient: string;
      amount: number;
      chain: string;
      asset: string;
      amount_unit?: "human" | "atomic";
    };
    request_body: Record<string, unknown>;
    context?: {
      reasoning_process?: string;
      current_task?: string;
    };
    idempotencyKey?: string;
  }) => Promise<{ merchant_response?: unknown }>;
};

function headersToObject(headersInit?: HeadersInit): Record<string, string> {
  if (!headersInit) return {};
  const headers = new Headers(headersInit);
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "content-length" || lower === "connection") continue;
    out[key] = value;
  }
  return out;
}

function parseJsonBody(body: RequestInit["body"]): unknown {
  if (body == null) return undefined;

  let raw = "";
  if (typeof body === "string") {
    raw = body;
  } else if (body instanceof Uint8Array) {
    raw = Buffer.from(body).toString("utf-8");
  } else if (body instanceof ArrayBuffer) {
    raw = Buffer.from(body).toString("utf-8");
  } else {
    return undefined;
  }

  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function microsToUsd(estimatedAmount?: string): number {
  const micros = Number(estimatedAmount ?? "");
  if (!Number.isFinite(micros) || micros <= 0) return 0.01;
  return Number((micros / 1_000_000).toFixed(6));
}

function inferStatusCode(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/ClawCredit API Error:\s*(\d{3})\s*-/i);
  if (match) return parseInt(match[1], 10);
  if (/payment required/i.test(msg)) return 402;
  if (/prequalification_pending/i.test(msg)) return 403;
  if (/unauthorized/i.test(msg)) return 401;
  return 502;
}

/**
 * Create a fetch wrapper that pays through claw.credit SDK instead of local x402 signing.
 */
export function createClawCreditFetch(config: ClawCreditConfig) {
  const serviceUrl = (config.baseUrl || DEFAULT_SERVICE_URL).replace(/\/+$/, "");
  const chain = config.chain.toUpperCase();
  const asset = config.asset;
  const apiToken = config.apiToken.trim();

  if (!apiToken) {
    throw new Error("CLAWCREDIT_API_TOKEN is required for claw.credit payment mode");
  }

  const credit = new ClawCredit({
    serviceUrl,
    apiToken,
    agent: config.agent,
    agentId: config.agentId,
  }) as SdkClient;

  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
    preAuth?: PreAuthParams,
  ): Promise<Response> => {
    const upstreamUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method || "POST").toUpperCase();
    const headers = headersToObject(init?.headers);
    const idempotencyKey = new Headers(init?.headers).get("idempotency-key") || undefined;
    const requestBody = parseJsonBody(init?.body);
    const amountUsd = microsToUsd(preAuth?.estimatedAmount);

    try {
      const result = await withTrace(async () =>
        credit.pay({
          transaction: {
            recipient: upstreamUrl,
            amount: amountUsd,
            chain,
            asset,
          },
          request_body: {
            http: {
              url: upstreamUrl,
              method,
              headers,
            },
            body: requestBody,
          },
          context: {
            current_task: "blockrun_inference_via_clawrouter",
            reasoning_process: "Proxying BlockRun inference payment through claw.credit SDK",
          },
          idempotencyKey,
        }),
      );

      const merchantResponse =
        result && typeof result === "object" && "merchant_response" in result
          ? (result as { merchant_response?: unknown }).merchant_response
          : result;

      return new Response(JSON.stringify(merchantResponse ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      const status = inferStatusCode(err);
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
  };
}
