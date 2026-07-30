/**
 * End-to-end test for ClawRouter proxy.
 *
 * Local mode always runs with a deterministic mock BlockRun upstream:
 *   npm run test:e2e
 *
 * Live paid mode also runs a small upstream smoke suite when a funded wallet is set:
 *   BLOCKRUN_WALLET_KEY=0x... npm run test:e2e
 *
 * Optional live coverage:
 *   CLAWROUTER_E2E_FULL=1     run slower/costlier live stress cases
 *   RUN_IMAGE_TEST=1          run live image generation
 *   RUN_MUSIC_TEST=1          run live music generation (costly, slow)
 */

import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { ProxyHandle } from "../src/proxy.js";

const ENV_WALLET_KEY = process.env.BLOCKRUN_WALLET_KEY?.trim();
if (ENV_WALLET_KEY && !/^0x[0-9a-fA-F]{64}$/.test(ENV_WALLET_KEY)) {
  console.error("ERROR: BLOCKRUN_WALLET_KEY must be 0x + 64 hex characters");
  process.exit(1);
}

const RUN_PAID_TESTS = Boolean(ENV_WALLET_KEY) && process.env.CLAWROUTER_E2E_LIVE !== "0";
const RUN_FULL_LIVE_TESTS = RUN_PAID_TESTS && process.env.CLAWROUTER_E2E_FULL === "1";
const RUN_IMAGE_TEST = RUN_PAID_TESTS && process.env.RUN_IMAGE_TEST === "1";
const RUN_MUSIC_TEST = RUN_PAID_TESTS && process.env.RUN_MUSIC_TEST === "1";
const REQUEST_TIMEOUT_MS = Number(process.env.CLAWROUTER_E2E_TIMEOUT_MS ?? 30_000);
const TEST_HOME =
  process.env.CLAWROUTER_E2E_HOME ?? join(tmpdir(), `clawrouter-e2e-${process.pid}`);
const CLEAN_TEST_HOME = !process.env.CLAWROUTER_E2E_HOME;

process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const LOCAL_WALLET_KEY = generatePrivateKey();
const LIVE_WALLET_KEY = ENV_WALLET_KEY as `0x${string}` | undefined;
const TINY_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const TINY_MP3_BYTES = Buffer.from("ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000", "binary");

type StartProxy = typeof import("../src/proxy.js").startProxy;

type TestStatus = "PASS" | "FAIL" | "SKIP";
type TestResult = {
  name: string;
  status: TestStatus;
  error?: string;
};

type ResponsePayload = {
  text: string;
  json?: unknown;
};

type SsePayload = {
  text: string;
  content: string;
  dataEvents: number;
  hasDone: boolean;
  hasHeartbeat: boolean;
};

type MockRequest = {
  method: string;
  path: string;
  bodyText: string;
  json?: unknown;
};

type MockUpstream = {
  url: string;
  requests: MockRequest[];
  close: () => Promise<void>;
};

const results: TestResult[] = [];

function getListeningPort(server: Server): number {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to resolve listening port");
  }
  return addr.port;
}

async function readRequestText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString();
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function chatCompletion(model: string, content: string): Record<string, unknown> {
  return {
    id: `chatcmpl-e2e-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: Math.max(1, Math.ceil(content.length / 4)),
      total_tokens: Math.max(13, Math.ceil(content.length / 4) + 12),
    },
  };
}

function writeSseCompletion(res: ServerResponse, model: string, content: string): void {
  const id = `chatcmpl-e2e-stream-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": heartbeat\n\n");

  const chunks = content.match(/.{1,32}/g) ?? [content];
  for (const chunk of chunks) {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
      })}\n\n`,
    );
  }

  res.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function getLastUserContent(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = asRecord(messages[i]);
    if (message.role !== "user") continue;
    return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  }
  return "";
}

function mockChatContent(body: Record<string, unknown>): string {
  const prompt = getLastUserContent(body.messages).toLowerCase();
  const model = typeof body.model === "string" ? body.model : "unknown";

  if (prompt.includes("2+2")) return "4";
  if (prompt.includes("7 times 8")) return "56";
  if (prompt.includes("capital of france")) return "Paris";
  if (prompt.includes("gravity")) return "Gravity is the attraction between masses.";
  if (prompt.includes("count to")) return "1, 2, 3, 4, 5";
  if (prompt.includes("50-word story")) {
    return [
      "A small cat named Mira guarded a sunlit bakery window.",
      "Each morning she watched flour drift, bells ring, and neighbors wave.",
      "When rain arrived, she curled beside the warm oven and purred so loudly",
      "that every loaf seemed to rise a little higher.",
    ].join(" ");
  }
  if (prompt.length > 100_000) return "Large payload accepted by mock upstream.";
  if (prompt.includes("hello")) return "hello";
  return `mock response from ${model}`;
}

async function startMockUpstream(): Promise<MockUpstream> {
  const requests: MockRequest[] = [];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

    if (req.method === "GET" && path === "/mock-assets/tiny.png") {
      const data = Buffer.from(TINY_PNG_DATA_URI.split(",")[1]!, "base64");
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": data.length });
      res.end(data);
      return;
    }

    if (req.method === "GET" && path === "/mock-assets/tiny.mp3") {
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": TINY_MP3_BYTES.length });
      res.end(TINY_MP3_BYTES);
      return;
    }

    const bodyText = await readRequestText(req);
    let parsed: unknown;
    try {
      parsed = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      parsed = undefined;
    }
    requests.push({ method: req.method ?? "GET", path, bodyText, json: parsed });

    if (req.method === "POST" && path === "/v1/images/generations") {
      writeJson(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data: [{ url: TINY_PNG_DATA_URI, revised_prompt: "e2e mock image" }],
      });
      return;
    }

    if (req.method === "POST" && path === "/v1/audio/generations") {
      const port = getListeningPort(server);
      writeJson(res, 200, {
        created: Math.floor(Date.now() / 1000),
        model: "minimax/music-3.0",
        data: [
          {
            url: `http://127.0.0.1:${port}/mock-assets/tiny.mp3`,
            duration_seconds: 1,
          },
        ],
      });
      return;
    }

    if (req.method !== "POST" || path !== "/v1/chat/completions") {
      writeJson(res, 404, { error: { message: `mock route not found: ${req.method} ${path}` } });
      return;
    }

    if (!parsed) {
      writeJson(res, 400, { error: { message: "Invalid JSON request body" } });
      return;
    }

    const body = asRecord(parsed);
    const model = typeof body.model === "string" ? body.model : "unknown";
    if (model.includes("invalid") || model.includes("nonexistent")) {
      writeJson(res, 404, { error: { message: `Unknown model: ${model}` } });
      return;
    }
    if (!Array.isArray(body.messages)) {
      writeJson(res, 400, { error: { message: "messages field is required" } });
      return;
    }
    if (body.messages.length === 0) {
      writeJson(res, 400, { error: { message: "messages must contain at least one item" } });
      return;
    }
    if (typeof body.max_tokens === "number" && body.max_tokens < 0) {
      writeJson(res, 400, { error: { message: "max_tokens must be non-negative" } });
      return;
    }

    const content = mockChatContent(body);
    if (body.stream === true) {
      writeSseCompletion(res, model, content);
      return;
    }

    writeJson(res, 200, chatCompletion(model, content));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = getListeningPort(server);
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function readResponseBody(res: Response): Promise<ResponsePayload> {
  const text = await res.text();
  try {
    return { text, json: JSON.parse(text) as unknown };
  } catch {
    return { text };
  }
}

function extractErrorMessage(payload: ResponsePayload): string {
  if (payload.json && typeof payload.json === "object") {
    const root = payload.json as Record<string, unknown>;
    const error = root.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const msg = (error as Record<string, unknown>).message;
      if (typeof msg === "string") return msg;
    }
    if (typeof root.message === "string") return root.message;
  }
  return payload.text;
}

function extractFirstMessageContent(payload: ResponsePayload): string | undefined {
  if (!payload.json || typeof payload.json !== "object") return undefined;
  const root = payload.json as Record<string, unknown>;
  if (!Array.isArray(root.choices) || root.choices.length === 0) return undefined;
  const firstChoice = root.choices[0];
  if (!firstChoice || typeof firstChoice !== "object") return undefined;
  const message = (firstChoice as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}

async function collectSse(res: Response): Promise<SsePayload> {
  const text = await res.text();
  let content = "";
  let dataEvents = 0;
  let hasDone = false;

  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const raw = line.slice(6).trim();
    if (raw === "[DONE]") {
      hasDone = true;
      continue;
    }
    dataEvents++;
    try {
      const parsed = JSON.parse(raw);
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === "string") content += delta;
      const error = parsed.error?.message ?? parsed.error;
      if (error) throw new Error(typeof error === "string" ? error : JSON.stringify(error));
    } catch (err) {
      if (err instanceof Error && raw.includes('"error"')) throw err;
    }
  }

  return { text, content, dataEvents, hasDone, hasHeartbeat: text.includes(": heartbeat") };
}

function timeoutSignal(timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, { ...init, signal: init?.signal ?? timeoutSignal(timeoutMs) });
}

async function postJson(
  proxy: ProxyHandle,
  path: string,
  body: unknown,
  timeoutMs?: number,
): Promise<Response> {
  return fetchWithTimeout(
    `${proxy.baseUrl}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
}

async function runTest(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  process.stdout.write(`  ${name} ... `);
  try {
    const detail = await fn();
    if (detail) process.stdout.write(`${detail} `);
    console.log("PASS");
    results.push({ name, status: "PASS" });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log("FAIL");
    console.error(`    ${message}`);
    results.push({ name, status: "FAIL", error: message });
    return false;
  }
}

function skipTest(name: string, reason: string): void {
  console.log(`  ${name} ... SKIP (${reason})`);
  results.push({ name, status: "SKIP" });
}

async function expectChatContent(res: Response, expectedStatus = 200): Promise<string> {
  const payload = await readResponseBody(res);
  if (res.status !== expectedStatus) {
    throw new Error(`Expected ${expectedStatus}, got ${res.status}: ${payload.text.slice(0, 300)}`);
  }
  const content = extractFirstMessageContent(payload);
  if (!content) throw new Error(`Missing chat content: ${payload.text.slice(0, 300)}`);
  return content;
}

function countMockChatRequests(mock: MockUpstream, since = 0): number {
  return mock.requests.slice(since).filter((r) => r.path === "/v1/chat/completions").length;
}

async function runLocalSuite(startProxy: StartProxy): Promise<boolean> {
  console.log("\n=== Local deterministic e2e (mock upstream) ===\n");

  const mock = await startMockUpstream();
  let proxy: ProxyHandle | undefined;
  let allPassed = true;

  try {
    proxy = await startProxy({
      wallet: LOCAL_WALLET_KEY,
      apiBase: mock.url,
      port: 0,
      skipBalanceCheck: true,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onReady: (port) => console.log(`Proxy ready on port ${port}`),
      onError: (err) => console.error(`Proxy error: ${err.message}`),
      onRouted: (d) =>
        console.log(
          `  [routed] ${d.model} (${d.tier}, ${d.method}, confidence=${d.confidence.toFixed(2)})`,
        ),
    });

    allPassed =
      (await runTest("Health check", async () => {
        const res = await fetchWithTimeout(`${proxy!.baseUrl}/health`);
        const payload = await readResponseBody(res);
        if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
        const body = asRecord(payload.json);
        if (body.status !== "ok") throw new Error(`Expected status ok, got ${body.status}`);
        if (!body.wallet) throw new Error("Missing wallet in health response");
        return `(wallet=${String(body.wallet)})`;
      })) && allPassed;

    allPassed =
      (await runTest("Non-streaming request through proxy", async () => {
        const res = await postJson(proxy!, "/v1/chat/completions", {
          model: "deepseek/deepseek-chat",
          messages: [{ role: "user", content: "What is 2+2? Reply with just the number." }],
          max_tokens: 10,
          stream: false,
        });
        const content = await expectChatContent(res);
        if (!content.includes("4")) throw new Error(`Expected "4" in response, got: ${content}`);
        return `(response="${content.trim()}")`;
      })) && allPassed;

    allPassed =
      (await runTest("Streaming request through proxy", async () => {
        const res = await postJson(proxy!, "/v1/chat/completions", {
          model: "google/gemini-2.5-flash",
          messages: [{ role: "user", content: "Say hello in one word." }],
          max_tokens: 10,
          stream: true,
        });
        if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
        const ct = res.headers.get("content-type");
        if (!ct?.includes("text/event-stream")) {
          throw new Error(`Expected text/event-stream, got ${ct}`);
        }
        const sse = await collectSse(res);
        if (!sse.hasDone) throw new Error("Missing [DONE] marker");
        if (!sse.content.trim()) throw new Error("Missing streamed content");
        return `(events=${sse.dataEvents}, done=${sse.hasDone}, content="${sse.content.trim()}")`;
      })) && allPassed;

    allPassed =
      (await runTest("Smart routing: simple query (blockrun/auto)", async () => {
        const res = await postJson(proxy!, "/v1/chat/completions", {
          model: "blockrun/auto",
          messages: [
            {
              role: "user",
              content:
                "What is the capital of France? Respond with exactly one word in English: Paris.",
            },
          ],
          max_tokens: 40,
          stream: false,
        });
        const content = await expectChatContent(res);
        if (!/paris/i.test(content))
          throw new Error(`Expected Paris-related answer, got: ${content}`);
        return `(response="${content.trim()}")`;
      })) && allPassed;

    allPassed =
      (await runTest("Smart routing: streaming (blockrun/auto)", async () => {
        const res = await postJson(proxy!, "/v1/chat/completions", {
          model: "blockrun/auto",
          messages: [{ role: "user", content: "Define gravity in one sentence." }],
          max_tokens: 50,
          stream: true,
        });
        if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
        const sse = await collectSse(res);
        if (!sse.hasDone) throw new Error("Missing [DONE]");
        if (sse.dataEvents === 0) throw new Error("No SSE data events received");
        return `(events=${sse.dataEvents}, content="${sse.content.trim().slice(0, 60)}")`;
      })) && allPassed;

    allPassed =
      (await runTest("Dedup: identical request returns cached response", async () => {
        const body = {
          model: "deepseek/deepseek-chat",
          messages: [
            {
              role: "user",
              content: "What is 7 times 8? Reply with just the number, nothing else.",
            },
          ],
          max_tokens: 5,
          stream: false,
        };
        const before = mock.requests.length;
        const first = await postJson(proxy!, "/v1/chat/completions", body);
        const firstContent = await expectChatContent(first);
        const second = await postJson(proxy!, "/v1/chat/completions", body);
        const secondContent = await expectChatContent(second);
        if (firstContent.trim() !== secondContent.trim()) {
          throw new Error(`Cached response changed: ${firstContent} vs ${secondContent}`);
        }
        const upstreamCalls = countMockChatRequests(mock, before);
        if (upstreamCalls !== 1) {
          throw new Error(`Expected 1 upstream call for cached request, got ${upstreamCalls}`);
        }
        return `(upstreamCalls=${upstreamCalls}, response="${secondContent.trim()}")`;
      })) && allPassed;

    allPassed =
      (await runTest("404 for unknown path", async () => {
        const res = await fetchWithTimeout(`${proxy!.baseUrl}/unknown`);
        if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
        return `(status=${res.status})`;
      })) && allPassed;

    allPassed =
      (await runTest("Large payload handling (>150KB)", async () => {
        const largeContent = "x".repeat(160 * 1024);
        const res = await postJson(proxy!, "/v1/chat/completions", {
          model: "deepseek/deepseek-chat",
          messages: [{ role: "user", content: largeContent }],
          max_tokens: 10,
          stream: false,
        });
        const payload = await readResponseBody(res);
        if (res.status === 413) {
          const errorMsg = extractErrorMessage(payload).toLowerCase();
          if (!errorMsg.includes("payload") && !errorMsg.includes("large")) {
            throw new Error(`Expected payload-size error message, got: ${errorMsg.slice(0, 200)}`);
          }
          return `(status=413)`;
        }
        if (res.status !== 200) {
          throw new Error(`Expected 200 or 413, got ${res.status}: ${payload.text.slice(0, 300)}`);
        }
        const content = extractFirstMessageContent(payload);
        if (!content) throw new Error("Expected non-empty content when large payload succeeds");
        return `(status=200, response="${content.slice(0, 60)}")`;
      })) && allPassed;

    allPassed =
      (await runTest("Malformed JSON handling", async () => {
        const res = await fetchWithTimeout(`${proxy!.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{invalid json}",
        });
        const payload = await readResponseBody(res);
        if (res.status !== 400 && res.status !== 502) {
          throw new Error(`Expected 400 or 502, got ${res.status}: ${payload.text.slice(0, 300)}`);
        }
        const errorMsg = extractErrorMessage(payload);
        if (!errorMsg.trim()) throw new Error("Expected non-empty error response");
        return `(status=${res.status}, error="${errorMsg.slice(0, 80)}")`;
      })) && allPassed;

    allPassed =
      (await runTest("Missing messages field is rejected", async () => {
        const res = await postJson(proxy!, "/v1/chat/completions", {
          model: "deepseek/deepseek-chat",
          max_tokens: 10,
          stream: false,
        });
        const payload = await readResponseBody(res);
        if (res.status < 400) {
          throw new Error(
            `Expected error status, got ${res.status}: ${payload.text.slice(0, 300)}`,
          );
        }
        const errorMsg = extractErrorMessage(payload).toLowerCase();
        if (!errorMsg.includes("message") && !errorMsg.includes("invalid request")) {
          throw new Error(`Unexpected error message: ${errorMsg.slice(0, 200)}`);
        }
        return `(status=${res.status}, error="${extractErrorMessage(payload).slice(0, 80)}")`;
      })) && allPassed;

    allPassed =
      (await runTest(">200 messages are handled via truncation", async () => {
        const messages = Array.from({ length: 201 }, (_, i) => ({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}`,
        }));
        const res = await postJson(proxy!, "/v1/chat/completions", {
          model: "deepseek/deepseek-chat",
          messages,
          max_tokens: 10,
          stream: false,
        });
        const content = await expectChatContent(res);
        return `(response="${content.slice(0, 60)}")`;
      })) && allPassed;

    allPassed =
      (await runTest("400/404 Bad Request (invalid model name)", async () => {
        const res = await postJson(proxy!, "/v1/chat/completions", {
          model: "invalid/nonexistent-model",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 10,
          stream: false,
        });
        const payload = await readResponseBody(res);
        if (res.status !== 400 && res.status !== 404) {
          throw new Error(`Expected 400 or 404, got ${res.status}: ${payload.text.slice(0, 300)}`);
        }
        const errorMsg = extractErrorMessage(payload);
        if (!errorMsg.trim()) throw new Error("Expected non-empty error response");
        return `(status=${res.status}, error="${errorMsg.slice(0, 80)}")`;
      })) && allPassed;

    allPassed =
      (await runTest("Concurrent requests (5 parallel)", async () => {
        const requests = Array.from({ length: 5 }, (_, i) =>
          postJson(proxy!, "/v1/chat/completions", {
            model: "deepseek/deepseek-chat",
            messages: [{ role: "user", content: `Count to ${i + 1}` }],
            max_tokens: 20,
            stream: false,
          }),
        );
        const responses = await Promise.all(requests);
        const statuses = responses.map((r) => r.status);
        if (!statuses.every((s) => s === 200)) {
          throw new Error(`Not all requests succeeded: ${statuses.join(", ")}`);
        }
        const bodies = await Promise.all(responses.map(readResponseBody));
        if (!bodies.every((b) => extractFirstMessageContent(b))) {
          throw new Error("Not all responses have content");
        }
        return `(all ${responses.length} requests succeeded)`;
      })) && allPassed;

    allPassed =
      (await runTest("400 Bad Request (negative max_tokens)", async () => {
        const res = await postJson(proxy!, "/v1/chat/completions", {
          model: "deepseek/deepseek-chat",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: -100,
          stream: false,
        });
        const payload = await readResponseBody(res);
        if (res.status !== 400) {
          throw new Error(`Expected 400, got ${res.status}: ${payload.text.slice(0, 300)}`);
        }
        const errorMsg = extractErrorMessage(payload);
        if (!errorMsg.trim()) throw new Error("Expected error in response");
        return `(error="${errorMsg.slice(0, 80)}")`;
      })) && allPassed;

    allPassed =
      (await runTest("Empty messages array handling", async () => {
        const res = await postJson(proxy!, "/v1/chat/completions", {
          model: "deepseek/deepseek-chat",
          messages: [],
          max_tokens: 10,
          stream: false,
        });
        const payload = await readResponseBody(res);
        if (res.status === 200) {
          const content = extractFirstMessageContent(payload);
          if (!content) throw new Error("Expected non-empty content when request succeeds");
          return `(status=200, response="${content.slice(0, 60)}")`;
        }
        if (res.status !== 400) {
          throw new Error(`Expected 200 or 400, got ${res.status}: ${payload.text.slice(0, 300)}`);
        }
        const errorMsg = extractErrorMessage(payload);
        if (!errorMsg.trim()) throw new Error("Expected error message for empty messages");
        return `(status=400, error="${errorMsg.slice(0, 80)}")`;
      })) && allPassed;

    allPassed =
      (await runTest("Streaming with large response", async () => {
        const res = await postJson(proxy!, "/v1/chat/completions", {
          model: "google/gemini-2.5-flash",
          messages: [{ role: "user", content: "Write a 50-word story about a cat." }],
          max_tokens: 100,
          stream: true,
        });
        if (res.status !== 200) {
          const payload = await readResponseBody(res);
          throw new Error(`Expected 200, got ${res.status}: ${payload.text.slice(0, 300)}`);
        }
        const sse = await collectSse(res);
        if (!sse.hasDone) throw new Error("Missing [DONE] marker");
        if (sse.content.length < 100) throw new Error("Response too short");
        return `(events=${sse.dataEvents}, length=${sse.content.length})`;
      })) && allPassed;

    allPassed =
      (await runTest("Image generation via mock upstream", async () => {
        const res = await postJson(proxy!, "/v1/images/generations", {
          model: "openai/gpt-image-1",
          prompt: "A simple red circle on a white background",
          size: "1024x1024",
          n: 1,
        });
        const payload = await readResponseBody(res);
        if (res.status !== 200) {
          throw new Error(`Expected 200, got ${res.status}: ${payload.text.slice(0, 300)}`);
        }
        const body = asRecord(payload.json);
        const data = body.data;
        if (!Array.isArray(data) || data.length === 0) throw new Error("Expected data array");
        const imageUrl = asRecord(data[0]).url;
        if (typeof imageUrl !== "string") throw new Error("Missing image url");
        if (!imageUrl.startsWith("http://localhost") && !imageUrl.startsWith("http://127.0.0.1")) {
          throw new Error(`Expected localhost URL, got: ${imageUrl}`);
        }
        const imgRes = await fetchWithTimeout(imageUrl);
        if (!imgRes.ok) throw new Error(`Image file not served: ${imgRes.status}`);
        const ct = imgRes.headers.get("content-type") ?? "";
        if (!ct.startsWith("image/")) throw new Error(`Expected image content-type, got: ${ct}`);
        const buf = await imgRes.arrayBuffer();
        if (buf.byteLength === 0) throw new Error("Image file is empty");
        return `(url=${imageUrl.split("/").pop()}, size=${buf.byteLength}B, type=${ct})`;
      })) && allPassed;

    allPassed =
      (await runTest("Audio generation via mock upstream", async () => {
        const res = await postJson(proxy!, "/v1/audio/generations", {
          model: "minimax/music-3.0",
          prompt: "Short tone",
          instrumental: true,
          duration_seconds: 1,
        });
        const payload = await readResponseBody(res);
        if (res.status !== 200) {
          throw new Error(`Expected 200, got ${res.status}: ${payload.text.slice(0, 300)}`);
        }
        const data = asRecord(payload.json).data;
        if (!Array.isArray(data) || data.length === 0) throw new Error("Expected data array");
        const audioUrl = asRecord(data[0]).url;
        if (typeof audioUrl !== "string") throw new Error("Missing audio url");
        if (!audioUrl.startsWith("http://localhost") && !audioUrl.startsWith("http://127.0.0.1")) {
          throw new Error(`Expected localhost URL, got: ${audioUrl}`);
        }
        const audioRes = await fetchWithTimeout(audioUrl);
        if (!audioRes.ok) throw new Error(`Audio file not served: ${audioRes.status}`);
        const ct = audioRes.headers.get("content-type") ?? "";
        if (!ct.startsWith("audio/")) throw new Error(`Expected audio content-type, got: ${ct}`);
        const buf = await audioRes.arrayBuffer();
        if (buf.byteLength === 0) throw new Error("Audio file is empty");
        return `(url=${audioUrl.split("/").pop()}, size=${buf.byteLength}B, type=${ct})`;
      })) && allPassed;

    allPassed =
      (await runTest("/images/ route - 404 for missing file", async () => {
        const res = await fetchWithTimeout(`${proxy!.baseUrl}/images/nonexistent.png`);
        if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
        return `(status=${res.status})`;
      })) && allPassed;

    allPassed =
      (await runTest("/audio/ route - 404 for missing file", async () => {
        const res = await fetchWithTimeout(`${proxy!.baseUrl}/audio/nonexistent.mp3`);
        if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
        return `(status=${res.status})`;
      })) && allPassed;
  } finally {
    await proxy?.close();
    await mock.close();
  }

  return allPassed;
}

async function runLiveSuite(startProxy: StartProxy): Promise<boolean> {
  if (!RUN_PAID_TESTS || !LIVE_WALLET_KEY) {
    console.log("\n=== Live paid e2e ===\n");
    skipTest("Live upstream smoke tests", "set funded BLOCKRUN_WALLET_KEY to enable");
    return true;
  }

  console.log("\n=== Live paid e2e ===\n");
  console.log(`Mode: LIVE, wallet=${privateKeyToAccount(LIVE_WALLET_KEY).address}`);

  let proxy: ProxyHandle | undefined;
  let allPassed = true;

  try {
    proxy = await startProxy({
      wallet: LIVE_WALLET_KEY,
      port: 0,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onReady: (port) => console.log(`Proxy ready on port ${port}`),
      onError: (err) => console.error(`Proxy error: ${err.message}`),
      onRouted: (d) =>
        console.log(
          `  [routed] ${d.model} (${d.tier}, ${d.method}, confidence=${d.confidence.toFixed(2)}, cost=$${d.costEstimate.toFixed(4)}, saved=${(d.savings * 100).toFixed(0)}%)`,
        ),
      onPayment: (info) =>
        console.log(`  [payment] ${info.model} ${info.amount} on ${info.network}`),
    });

    allPassed =
      (await runTest("Live balance check", async () => {
        if (!proxy!.balanceMonitor) throw new Error("Balance monitor not available");
        const balance = await proxy!.balanceMonitor.checkBalance();
        if (!balance || typeof balance.balanceUSD !== "string") {
          throw new Error("Balance check returned invalid response");
        }
        if (balance.isEmpty) throw new Error("Wallet is empty - please fund it");
        return `(balance=${balance.balanceUSD})`;
      })) && allPassed;

    allPassed =
      (await runTest("Live non-streaming request (deepseek/deepseek-chat)", async () => {
        const res = await postJson(
          proxy!,
          "/v1/chat/completions",
          {
            model: "deepseek/deepseek-chat",
            messages: [{ role: "user", content: "What is 2+2? Reply with just the number." }],
            max_tokens: 10,
            stream: false,
          },
          60_000,
        );
        const content = await expectChatContent(res);
        if (!content.includes("4")) throw new Error(`Expected "4" in response, got: ${content}`);
        return `(response="${content.trim()}")`;
      })) && allPassed;

    allPassed =
      (await runTest("Live streaming request (google/gemini-2.5-flash)", async () => {
        const res = await postJson(
          proxy!,
          "/v1/chat/completions",
          {
            model: "google/gemini-2.5-flash",
            messages: [{ role: "user", content: "Say hello in one word." }],
            max_tokens: 10,
            stream: true,
          },
          60_000,
        );
        if (res.status !== 200) {
          const payload = await readResponseBody(res);
          throw new Error(`Expected 200, got ${res.status}: ${payload.text.slice(0, 300)}`);
        }
        const sse = await collectSse(res);
        if (!sse.hasDone) throw new Error("Missing [DONE] marker");
        return `(events=${sse.dataEvents}, content="${sse.content.trim().slice(0, 60)}")`;
      })) && allPassed;

    allPassed =
      (await runTest("Live smart routing: simple query (blockrun/auto)", async () => {
        const res = await postJson(
          proxy!,
          "/v1/chat/completions",
          {
            model: "blockrun/auto",
            messages: [
              {
                role: "user",
                content:
                  "What is the capital of France? Respond with exactly one word in English: Paris.",
              },
            ],
            max_tokens: 40,
            stream: false,
          },
          60_000,
        );
        const content = await expectChatContent(res);
        if (!/(paris|capital|france|巴黎|法国|首都)/i.test(content)) {
          throw new Error(`Expected capital-of-France-related answer, got: ${content}`);
        }
        return `(response="${content.trim().slice(0, 60)}")`;
      })) && allPassed;

    if (RUN_FULL_LIVE_TESTS) {
      allPassed =
        (await runTest("Live concurrent requests (5 parallel)", async () => {
          const requests = Array.from({ length: 5 }, (_, i) =>
            postJson(
              proxy!,
              "/v1/chat/completions",
              {
                model: "deepseek/deepseek-chat",
                messages: [{ role: "user", content: `Count to ${i + 1}` }],
                max_tokens: 20,
                stream: false,
              },
              60_000,
            ),
          );
          const responses = await Promise.all(requests);
          const statuses = responses.map((r) => r.status);
          if (!statuses.every((s) => s === 200)) {
            throw new Error(`Not all requests succeeded: ${statuses.join(", ")}`);
          }
          return `(all ${responses.length} requests succeeded)`;
        })) && allPassed;
    } else {
      skipTest("Live concurrent requests (5 parallel)", "set CLAWROUTER_E2E_FULL=1");
    }

    if (RUN_IMAGE_TEST) {
      allPassed =
        (await runTest("Live image generation (openai/gpt-image-1)", async () => {
          const res = await postJson(
            proxy!,
            "/v1/images/generations",
            {
              model: "openai/gpt-image-1",
              prompt: "A simple red circle on a white background",
              size: "1024x1024",
              n: 1,
            },
            180_000,
          );
          const payload = await readResponseBody(res);
          if (res.status !== 200) {
            throw new Error(`Expected 200, got ${res.status}: ${payload.text.slice(0, 300)}`);
          }
          const data = asRecord(payload.json).data;
          if (!Array.isArray(data) || data.length === 0) throw new Error("Expected data array");
          const imageUrl = asRecord(data[0]).url;
          if (typeof imageUrl !== "string") throw new Error("Missing url in data[0]");
          const imgRes = await fetchWithTimeout(imageUrl, undefined, 30_000);
          if (!imgRes.ok) throw new Error(`Image file not served: ${imgRes.status}`);
          const buf = await imgRes.arrayBuffer();
          if (buf.byteLength < 1000) throw new Error(`Image too small: ${buf.byteLength} bytes`);
          return `(url=${imageUrl.split("/").pop()}, size=${(buf.byteLength / 1024).toFixed(0)}KB)`;
        })) && allPassed;
    } else {
      skipTest("Live image generation (openai/gpt-image-1)", "set RUN_IMAGE_TEST=1");
    }

    if (RUN_MUSIC_TEST) {
      allPassed =
        (await runTest("Live music generation (minimax/music-3.0)", async () => {
          const res = await postJson(
            proxy!,
            "/v1/audio/generations",
            {
              model: "minimax/music-3.0",
              prompt: "Upbeat electronic music with a fast beat",
              instrumental: true,
              duration_seconds: 30,
            },
            210_000,
          );
          const payload = await readResponseBody(res);
          if (res.status !== 200) {
            throw new Error(`Expected 200, got ${res.status}: ${payload.text.slice(0, 300)}`);
          }
          const data = asRecord(payload.json).data;
          if (!Array.isArray(data) || data.length === 0) throw new Error("Expected data array");
          const audioUrl = asRecord(data[0]).url;
          if (typeof audioUrl !== "string") throw new Error("Missing url in data[0]");
          const audioRes = await fetchWithTimeout(audioUrl, undefined, 30_000);
          if (!audioRes.ok) throw new Error(`Audio file not served: ${audioRes.status}`);
          const buf = await audioRes.arrayBuffer();
          if (buf.byteLength < 10_000) throw new Error(`Audio too small: ${buf.byteLength} bytes`);
          return `(url=${audioUrl.split("/").pop()}, size=${(buf.byteLength / 1024).toFixed(0)}KB)`;
        })) && allPassed;
    } else {
      skipTest("Live music generation (minimax/music-3.0)", "set RUN_MUSIC_TEST=1");
    }
  } finally {
    await proxy?.close();
  }

  return allPassed;
}

function printSummary(): boolean {
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;

  console.log("\n=== E2E SUMMARY ===");
  console.log(`Passed: ${passed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const result of results.filter((r) => r.status === "FAIL")) {
      console.log(`  - ${result.name}: ${result.error}`);
    }
  }

  console.log();
  return failed === 0;
}

async function main(): Promise<void> {
  console.log("\n=== ClawRouter e2e tests ===\n");
  console.log(`Temp HOME: ${TEST_HOME}`);
  if (RUN_PAID_TESTS && LIVE_WALLET_KEY) {
    console.log("Live paid mode: enabled");
  } else {
    console.log("Live paid mode: disabled (local mock suite still runs)");
  }

  const { startProxy } = await import("../src/proxy.js");
  let allPassed = true;

  try {
    allPassed = (await runLocalSuite(startProxy)) && allPassed;
    allPassed = (await runLiveSuite(startProxy)) && allPassed;
  } finally {
    if (CLEAN_TEST_HOME) {
      await rm(TEST_HOME, { recursive: true, force: true });
    }
  }

  allPassed = printSummary() && allPassed;
  process.exit(allPassed ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Fatal:", err instanceof Error ? err.stack || err.message : String(err));
  if (CLEAN_TEST_HOME) {
    await rm(TEST_HOME, { recursive: true, force: true }).catch(() => {});
  }
  process.exit(1);
});
