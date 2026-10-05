import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { isBlockedSsrfHost, readLocalImageAsDataUri, ssrfSafeFetch } from "./local-guard.js";
import { buildPartnerTools } from "./partners/tools.js";
import { startProxy, type ProxyHandle } from "./proxy.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const FAKE_KEY = "0x" + "ab".repeat(32);

describe("isBlockedSsrfHost", () => {
  it("blocks loopback, private, metadata and IPv4-embedding IPv6 forms", () => {
    for (const h of [
      "localhost",
      "localhost.",
      "127.0.0.1",
      "[::1]",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.100.100.200",
      "100.64.0.1",
      "192.0.0.192",
      "metadata.google.internal",
      "instance-data",
      "::ffff:7f00:1",
      "[::ffff:127.0.0.1]",
      "2002:7f00:1::",
      "64:ff9b::7f00:1",
      "fd00::1",
    ]) {
      expect(isBlockedSsrfHost(h), h).toBe(true);
    }
  });

  it("allows public hosts", () => {
    for (const h of ["example.com", "8.8.8.8", "fda.gov", "blockrun.ai"]) {
      expect(isBlockedSsrfHost(h), h).toBe(false);
    }
  });
});

describe("ssrfSafeFetch", () => {
  it("refuses a public URL that redirects into loopback", async () => {
    const orig = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response("", {
        status: 302,
        headers: { Location: "http://127.0.0.1:8402/health" },
      });
    }) as typeof fetch;
    try {
      await expect(ssrfSafeFetch("https://attacker.example/x.png")).rejects.toThrow(
        /private\/loopback/,
      );
      expect(calls).toEqual(["https://attacker.example/x.png"]);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("readLocalImageAsDataUri", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cr-img-"));
    writeFileSync(join(dir, "ok.png"), PNG);
    writeFileSync(join(dir, "wallet.key"), FAKE_KEY);
    writeFileSync(join(dir, "fake.png"), FAKE_KEY);
    symlinkSync(join(dir, "wallet.key"), join(dir, "link.png"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a real image by its bytes", () => {
    expect(readLocalImageAsDataUri(join(dir, "ok.png"))).toMatch(/^data:image\/png;base64,/);
  });

  it("refuses non-images whatever the name, without revealing existence", () => {
    const err = (p: string) => {
      try {
        readLocalImageAsDataUri(p);
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    };
    for (const p of ["wallet.key", "fake.png", "link.png", "missing.png"]) {
      const msg = err(join(dir, p));
      expect(msg, p).toMatch(/Not a readable PNG, JPEG or WebP image/);
      expect(msg).not.toContain(FAKE_KEY);
    }
    expect(err(join(dir, "missing.png"))).toBe(
      err(join(dir, "wallet.key")).replace("wallet.key", "missing.png"),
    );
  });
});

describe("dynamic Predexon endpoint path check", () => {
  const tool = buildPartnerTools("http://127.0.0.1:1").find((t) =>
    t.name.endsWith("endpoint_call"),
  );

  it("cannot leave the /pm namespace via percent-encoding", async () => {
    expect(tool).toBeDefined();
    for (const path of [
      "/pm/%2e%2e/voice/call",
      "/pm/%2E%2E/modal/x",
      "/pm/..%2fvoice/call",
      "/pm/../voice/call",
    ]) {
      await expect(tool!.execute("t", { path }), path).rejects.toThrow(/invalid path/);
    }
  });
});

describe("proxy refuses cross-site and non-local requests", () => {
  let upstream: Server;
  let proxy: ProxyHandle;
  let paidHits = 0;
  let dir: string;
  let port: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cr-proxy-guard-"));
    writeFileSync(join(dir, "wallet.key"), FAKE_KEY);
    upstream = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        // Startup traffic (model list, balance) is not a spend; count the rest.
        if (!req.url?.startsWith("/v1/models")) paidHits++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    proxy = await startProxy({
      apiKey: "brk_live_" + "z".repeat(48),
      apiBase: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      port: 0,
      allowExistingProxy: false,
    });
    port = Number(new URL(proxy.baseUrl).port);
  }, 20_000);

  afterAll(async () => {
    await proxy?.close();
    upstream.closeAllConnections?.();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    paidHits = 0;
  });

  const send = (path: string, headers: Record<string, string>, body?: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = request(
        { host: "127.0.0.1", port, path, method: body ? "POST" : "GET", headers, agent: false },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      r.on("error", reject);
      if (body) r.write(body);
      r.end();
    });

  it("drive-by text/plain POST from a web page is refused before any spend", async () => {
    const res = await send(
      "/v1/images/generations",
      { Origin: "https://evil.example", "Content-Type": "text/plain" },
      JSON.stringify({ prompt: "x", model: "openai/gpt-image-1" }),
    );
    expect(res.status).toBe(403);
    expect(paidHits).toBe(0);
  });

  it("a DNS-rebinding Host is refused", async () => {
    const res = await send("/health", { Host: `attacker.example:${port}` });
    expect(res.status).toBe(403);
  });

  it("Sec-Fetch-Site: cross-site is refused even without Origin", async () => {
    const res = await send("/health", { "Sec-Fetch-Site": "cross-site" });
    expect(res.status).toBe(403);
  });

  it("native clients (no Origin) and local origins still work", async () => {
    expect((await send("/health", {})).status).toBe(200);
    expect((await send("/health", { Origin: `http://localhost:${port}` })).status).toBe(200);
  });

  it("img2img will not read a non-image local file", async () => {
    const res = await send(
      "/v1/images/image2image",
      { "Content-Type": "application/json" },
      JSON.stringify({ prompt: "x", image: join(dir, "wallet.key") }),
    );
    expect(res.status).toBe(400);
    expect(res.body).not.toContain(FAKE_KEY);
    expect(paidHits).toBe(0);
  });

  it("img2img will not fetch a loopback URL", async () => {
    const res = await send(
      "/v1/images/image2image",
      { "Content-Type": "application/json" },
      JSON.stringify({ prompt: "x", image: `http://127.0.0.1:${port}/health` }),
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatch(/private\/loopback/);
    expect(paidHits).toBe(0);
  });
});
