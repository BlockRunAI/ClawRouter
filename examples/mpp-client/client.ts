// Local payer against a fixture seller. The proxy is aimed at the Tempo MPP seller
// and openai/gpt-4o-mini, but createMppFetch is given an in-memory fetch: a 200
// chat completion whose content is "ok", plus a Payment-Receipt header.
// No key is read. The account is generated in memory and discarded. Sockets are
// refused unless they stay on the local proxy port.
//
//   npm install && npm start
import net from "node:net";
import { startProxy, SpendControl, InMemorySpendControlStorage } from "@twzrd1111/clawrouter";
import { createMppFetch } from "@twzrd1111/clawrouter-mpp";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

type ConnectArgs = Parameters<net.Socket["connect"]>;

function endpointHost(args: ConnectArgs): string {
  const first: unknown = args[0];
  if (typeof first === "object" && first !== null) {
    const record = first as { path?: string; host?: string; hostname?: string };
    if (typeof record.path === "string") return "localhost";
    return record.host ?? record.hostname ?? "localhost";
  }
  if (typeof first === "string" && first.startsWith("/")) return "localhost";
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    const host: unknown = args[1];
    if (host === undefined || typeof host === "function") return "localhost";
    return String(host);
  }
  return "unknown";
}

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: ConnectArgs) {
  const host = String(endpointHost(args));
  if (!LOOPBACK.has(host)) {
    throw new Error(`refusing non-local connection to ${host}`);
  }
  return origConnect.apply(this, args);
};

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let host = "";
  try {
    host = new URL(url, "http://127.0.0.1").hostname;
  } catch {
    host = "";
  }
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return realFetch(input, init);
  }
  return Promise.resolve(
    new Response("{}", { status: 404, headers: { "content-type": "application/json" } }),
  );
};

const SELLER = "https://openrouter.mpp.tempo.xyz";
const MODEL = "openai/gpt-4o-mini";

interface ChatCompletion {
  choices: { message: { content: string } }[];
}

const COMPLETION: ChatCompletion = {
  choices: [{ message: { content: "ok" } }],
};

function memoryFetch(): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(COMPLETION), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "Payment-Receipt": "fixture.receipt.not-a-credential",
      },
    }),
  );
}

const account = privateKeyToAccount(generatePrivateKey());
const spend = new SpendControl({ storage: new InMemorySpendControlStorage() });
const payFetch = createMppFetch(account, memoryFetch as unknown as typeof fetch, { spend });

const proxy = await startProxy({
  spendControl: spend,
  payFetch,
  apiBase: SELLER,
  paymentChain: "base",
  wallet: generatePrivateKey(),
  skipBalanceCheck: true,
  port: 0,
  allowExistingProxy: false,
});

let exitCode = 1;
try {
  const r = await realFetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    }),
  });
  const text = await r.text();
  let content = "";
  try {
    content = (JSON.parse(text) as ChatCompletion)?.choices?.[0]?.message?.content ?? "";
  } catch {
    content = "";
  }
  if (r.status === 200 && content) {
    console.log(content);
    exitCode = 0;
  } else {
    console.error(text.slice(0, 500));
  }
} finally {
  await proxy.close();
}
process.exit(exitCode);
