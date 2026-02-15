/**
 * Claw Credit payment backend for ClawRouter.
 *
 * Converts a BlockRun upstream request into a claw.credit /v1/transaction/pay call
 * and returns the merchant_response as a standard fetch Response.
 */

import { VERSION } from "./version.js";

const DEFAULT_SERVICE_URL = "https://api.claw.credit";

export type ClawCreditConfig = {
  baseUrl?: string;
  apiToken: string;
  chain: string;
  asset: string;
};

export type PreAuthParams = {
  estimatedAmount: string;
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

/**
 * Create a fetch wrapper that pays through claw.credit instead of local x402 signing.
 */
export function createClawCreditFetch(config: ClawCreditConfig) {
  const serviceUrl = (config.baseUrl || DEFAULT_SERVICE_URL).replace(/\/+$/, "");
  const chain = config.chain.toUpperCase();
  const asset = config.asset;
  const apiToken = config.apiToken.trim();

  if (!apiToken) {
    throw new Error("CLAWCREDIT_API_TOKEN is required for claw.credit payment mode");
  }

  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
    preAuth?: PreAuthParams,
  ): Promise<Response> => {
    const upstreamUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method || "POST").toUpperCase();
    const headers = headersToObject(init?.headers);
    const requestBody = parseJsonBody(init?.body);
    const amountUsd = microsToUsd(preAuth?.estimatedAmount);

    const payload = {
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
      audit_context: {
        current_task: "blockrun_inference_via_clawrouter",
        reasoning_process: "Proxying BlockRun inference payment through claw.credit",
        timestamp: Date.now(),
      },
      sdk_meta: {
        sdk_name: "@blockrun/clawrouter",
        sdk_version: VERSION,
      },
    };

    const payResponse = await fetch(`${serviceUrl}/v1/transaction/pay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(payload),
      signal: init?.signal,
    });

    const text = await payResponse.text();
    const contentType = payResponse.headers.get("content-type") || "application/json";

    if (!payResponse.ok) {
      return new Response(text, {
        status: payResponse.status,
        headers: { "content-type": contentType },
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    const merchantResponse =
      parsed && typeof parsed === "object" && "merchant_response" in parsed
        ? (parsed as { merchant_response: unknown }).merchant_response
        : parsed;

    return new Response(JSON.stringify(merchantResponse ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
