import { describe, it, expect, vi, afterEach } from "vitest";
import { EnvHttpProxyAgent, ProxyAgent } from "undici";
import { applyUpstreamProxy } from "../src/upstream-proxy.js";

// All tests inject env + dispatcher via overrides — never mutate process.env
// or the global dispatcher, which other test files (and their fetches) share.
describe("applyUpstreamProxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined when no proxy is configured anywhere", async () => {
    const setDispatcher = vi.fn();
    expect(await applyUpstreamProxy(undefined, { env: {}, setDispatcher })).toBeUndefined();
    expect(setDispatcher).not.toHaveBeenCalled();
  });

  it("uses BLOCKRUN_UPSTREAM_PROXY when set", async () => {
    const setDispatcher = vi.fn();
    const env = { BLOCKRUN_UPSTREAM_PROXY: "http://127.0.0.1:8080" };
    expect(await applyUpstreamProxy(undefined, { env, setDispatcher })).toBe(
      "http://127.0.0.1:8080",
    );
    expect(setDispatcher).toHaveBeenCalledTimes(1);
    expect(setDispatcher.mock.calls[0][0]).toBeInstanceOf(ProxyAgent);
  });

  it("prefers BLOCKRUN_UPSTREAM_PROXY over standard env vars", async () => {
    const setDispatcher = vi.fn();
    const env = {
      BLOCKRUN_UPSTREAM_PROXY: "http://127.0.0.1:8080",
      HTTPS_PROXY: "http://127.0.0.1:7890",
    };
    expect(await applyUpstreamProxy(undefined, { env, setDispatcher })).toBe(
      "http://127.0.0.1:8080",
    );
    expect(setDispatcher.mock.calls[0][0]).toBeInstanceOf(ProxyAgent);
  });

  it("falls back to HTTPS_PROXY when BLOCKRUN_UPSTREAM_PROXY is unset", async () => {
    const setDispatcher = vi.fn();
    const env = { HTTPS_PROXY: "http://127.0.0.1:7890" };
    expect(await applyUpstreamProxy(undefined, { env, setDispatcher })).toBe(
      "http://127.0.0.1:7890",
    );
    expect(setDispatcher.mock.calls[0][0]).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("falls back to lowercase https_proxy", async () => {
    const setDispatcher = vi.fn();
    const env = { https_proxy: "http://127.0.0.1:7890" };
    expect(await applyUpstreamProxy(undefined, { env, setDispatcher })).toBe(
      "http://127.0.0.1:7890",
    );
    expect(setDispatcher.mock.calls[0][0]).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("falls back to ALL_PROXY when no scheme-specific vars are set", async () => {
    const setDispatcher = vi.fn();
    const env = { ALL_PROXY: "http://127.0.0.1:7890" };
    expect(await applyUpstreamProxy(undefined, { env, setDispatcher })).toBe(
      "http://127.0.0.1:7890",
    );
    expect(setDispatcher.mock.calls[0][0]).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("does not auto-apply SOCKS proxies from standard env vars", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setDispatcher = vi.fn();
    const env = { ALL_PROXY: "socks5://127.0.0.1:1080" };
    expect(await applyUpstreamProxy(undefined, { env, setDispatcher })).toBeUndefined();
    expect(setDispatcher).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("BLOCKRUN_UPSTREAM_PROXY"));
  });

  it("ignores invalid proxy URLs in standard env vars", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const setDispatcher = vi.fn();
    const env = { HTTPS_PROXY: "not a url" };
    expect(await applyUpstreamProxy(undefined, { env, setDispatcher })).toBeUndefined();
    expect(setDispatcher).not.toHaveBeenCalled();
  });

  it("explicit option wins over everything", async () => {
    const setDispatcher = vi.fn();
    const env = { HTTPS_PROXY: "http://127.0.0.1:7890" };
    expect(await applyUpstreamProxy("http://10.0.0.1:3128", { env, setDispatcher })).toBe(
      "http://10.0.0.1:3128",
    );
    expect(setDispatcher.mock.calls[0][0]).toBeInstanceOf(ProxyAgent);
  });
});
