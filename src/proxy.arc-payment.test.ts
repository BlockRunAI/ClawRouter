import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  describePaymentNetwork,
  stampsBuilderCode,
  startProxy,
  transformPaymentError,
  walletGatewayFor,
  type ProxyHandle,
} from "./proxy.js";
import {
  CAIP2_ARC,
  CAIP2_BASE,
  InMemorySpendControlStorage,
  SpendControl,
} from "./spend-control.js";
import { runPolicyCommand } from "./commands/policy.js";
import { ARC_CHAIN_ID, USDC_ARC } from "./payment-chain.js";

/**
 * Arc end to end through the real proxy payment path: the gateway answers 402
 * with `eip155:5042`, and the proxy must sign an EIP-3009 authorization over
 * Arc's USDC domain (name "USDC", version "2", chainId 5042, 0x3600…0000) — a
 * signature over Base's "USD Coin" domain would be refused by the facilitator
 * after the proxy had reported a payment.
 */

const PAY_TO = "0x634D274e67DafaF76C54153aa113906a606e1E0B";
const AMOUNT = "2000";

function arcChallenge(): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "http://127.0.0.1/v1/chat/completions" },
      accepts: [
        {
          scheme: "exact",
          network: CAIP2_ARC,
          amount: AMOUNT,
          asset: USDC_ARC,
          payTo: PAY_TO,
          maxTimeoutSeconds: 300,
          extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
        },
      ],
    }),
  ).toString("base64");
}

type SignedPayment = {
  x402Version: number;
  accepted: { network: string; asset: string };
  payload: {
    signature: `0x${string}`;
    authorization: {
      from: `0x${string}`;
      to: `0x${string}`;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: `0x${string}`;
    };
  };
  extensions?: Record<string, unknown>;
};

describe("Arc payment chain through startProxy", () => {
  const walletKey = generatePrivateKey();
  const walletAddress = privateKeyToAccount(walletKey).address;
  let upstream: Server;
  let proxy: ProxyHandle;
  let control: SpendControl;
  let payments: SignedPayment[] = [];

  beforeAll(async () => {
    upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.on("data", () => {});
      req.on("end", () => {
        const header = req.headers["payment-signature"] || req.headers["x-payment"];
        if (!header) {
          res.writeHead(402, {
            "Content-Type": "application/json",
            "PAYMENT-REQUIRED": arcChallenge(),
          });
          res.end(JSON.stringify({ error: "Payment Required" }));
          return;
        }
        payments.push(JSON.parse(Buffer.from(String(header), "base64").toString("utf8")));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-arc",
            object: "chat.completion",
            model: "openai/gpt-4o-mini",
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          }),
        );
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const port = (upstream.address() as AddressInfo).port;

    // Pin the policy surface too: Arc must be a network an operator can allowlist.
    const storage = new InMemorySpendControlStorage();
    const applied = runPolicyCommand(["set", "allowedNetworks", CAIP2_ARC], {
      openControl: () => new SpendControl({ storage }),
    });
    expect(applied.isError).toBeFalsy();
    control = new SpendControl({ storage });

    proxy = await startProxy({
      wallet: walletKey,
      paymentChain: "arc",
      apiBase: `http://127.0.0.1:${port}`,
      port: 0,
      skipBalanceCheck: true,
      spendControl: control,
    });
  }, 20_000);

  afterAll(async () => {
    await proxy?.close();
    upstream?.closeAllConnections?.();
    await new Promise<void>((r) => upstream?.close(() => r()));
  });

  beforeEach(() => {
    payments = [];
  });

  it("signs an EIP-3009 authorization over Arc's USDC domain", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        max_tokens: 5,
        messages: [{ role: "user", content: "arc payment test" }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(payments).toHaveLength(1);
    const payment = payments[0];
    expect(payment.accepted.network).toBe(CAIP2_ARC);
    const auth = payment.payload.authorization;
    expect(auth.from.toLowerCase()).toBe(walletAddress.toLowerCase());
    expect(auth.to.toLowerCase()).toBe(PAY_TO.toLowerCase());
    expect(auth.value).toBe(AMOUNT);

    const message = {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    };
    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    } as const;
    const arcDomain = {
      name: "USDC",
      version: "2",
      chainId: ARC_CHAIN_ID,
      verifyingContract: USDC_ARC,
    } as const;
    await expect(
      verifyTypedData({
        address: walletAddress,
        domain: arcDomain,
        types,
        primaryType: "TransferWithAuthorization",
        message,
        signature: payment.payload.signature,
      }),
    ).resolves.toBe(true);
    // And NOT over Base's domain on chain 5042 — the bug the TS SDK shipped once.
    await expect(
      verifyTypedData({
        address: walletAddress,
        domain: { ...arcDomain, name: "USD Coin" },
        types,
        primaryType: "TransferWithAuthorization",
        message,
        signature: payment.payload.signature,
      }),
    ).resolves.toBe(false);
  }, 30_000);

  it("does not stamp the CDP builder code onto an Arc payment", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        max_tokens: 5,
        messages: [{ role: "user", content: "arc builder code test" }],
        stream: false,
      }),
    });
    await res.text();
    expect(payments).toHaveLength(1);
    expect(payments[0].extensions?.["builder-code"]).toBeUndefined();
  }, 30_000);

  it("reports arc as the payment chain on /health", async () => {
    const health = (await (await fetch(`${proxy.baseUrl}/health`)).json()) as Record<
      string,
      unknown
    >;
    expect(health.paymentChain).toBe("arc");
    expect(health.wallet).toBe(walletAddress);
  });
});

describe("Arc chain helpers", () => {
  it("routes each chain to its own gateway", () => {
    expect(walletGatewayFor("arc", false)).toBe("https://arc.blockrun.ai/api");
    expect(walletGatewayFor("arc", true)).toBe("https://arc.blockrun.ai/api");
    expect(walletGatewayFor("base", true)).toBe("https://blockrun.ai/api");
    expect(walletGatewayFor("solana", true)).toBe("https://sol.blockrun.ai/api");
    // Solana with no Solana key falls back to Base, as before.
    expect(walletGatewayFor("solana", false)).toBe("https://blockrun.ai/api");
  });

  it("labels Arc payments as Arc, not Base", () => {
    expect(describePaymentNetwork(CAIP2_ARC)).toBe("Arc (EVM)");
    expect(describePaymentNetwork(CAIP2_BASE)).toBe("Base (EVM)");
    expect(describePaymentNetwork("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")).toBe(
      "Solana",
    );
  });

  it("stamps the builder code on Base only, never on Arc or Solana", () => {
    expect(stampsBuilderCode(CAIP2_BASE)).toBe(true);
    expect(stampsBuilderCode(CAIP2_ARC)).toBe(false);
    expect(stampsBuilderCode("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")).toBe(false);
  });

  it("tells an Arc user to fund on Arc, not Base, when the balance is short", () => {
    const body = JSON.stringify({
      error: "Payment verification failed",
      code: "PAYMENT_INVALID",
      debug: "insufficient funds",
      payer: "0xCC8c44AD3dc2A58D841c3EB26131E49b22665EF8",
    });
    const arc = JSON.parse(transformPaymentError(body, "Arc")).error;
    expect(arc.message).toBe("Insufficient Arc USDC balance.");
    expect(arc.help).toMatch(/USDC on Arc/);
    // Default unchanged for Base.
    expect(JSON.parse(transformPaymentError(body)).error.help).toMatch(/USDC on Base/);
  });
});
