/**
 * Upstream Proxy Support
 *
 * Configures a global fetch dispatcher when BLOCKRUN_UPSTREAM_PROXY is set.
 * Supports http://, https://, and socks5:// proxy URLs.
 *
 * When BLOCKRUN_UPSTREAM_PROXY is NOT set, falls back to the standard
 * HTTPS_PROXY / HTTP_PROXY / ALL_PROXY environment variables. Node's fetch
 * (undici) ignores these by default, which strands users whose system
 * traffic is meant to flow through a local proxy (e.g. mihomo/clash without
 * TUN mode): their curl tests succeed via the proxy while ClawRouter
 * connects directly and hits resets/throttling on the direct route.
 *
 * Usage:
 *   BLOCKRUN_UPSTREAM_PROXY=socks5://127.0.0.1:1080 clawrouter start
 *   BLOCKRUN_UPSTREAM_PROXY=http://127.0.0.1:8080 clawrouter start
 *   HTTPS_PROXY=http://127.0.0.1:7890 clawrouter start
 */

/** Test seam: inject env/dispatcher so unit tests never mutate process globals. */
export interface UpstreamProxyOverrides {
  env?: Record<string, string | undefined>;
  setDispatcher?: (dispatcher: unknown) => void;
}

function firstEnv(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

/**
 * Apply upstream proxy settings to the global fetch dispatcher.
 * Called once at proxy startup. BLOCKRUN_UPSTREAM_PROXY (or the explicit
 * option) wins; otherwise standard proxy env vars are honored.
 * Returns the proxy URL that was configured, or undefined if none.
 */
export async function applyUpstreamProxy(
  proxyUrl?: string,
  overrides?: UpstreamProxyOverrides,
): Promise<string | undefined> {
  const env = overrides?.env ?? process.env;
  const url = proxyUrl ?? env.BLOCKRUN_UPSTREAM_PROXY;
  if (!url) return applyEnvProxyFallback(env, overrides);

  // Validate URL format
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.warn(`[ClawRouter] Invalid BLOCKRUN_UPSTREAM_PROXY URL: ${url} — skipping proxy setup`);
    return undefined;
  }

  const scheme = parsed.protocol; // "http:", "https:", "socks5:"

  try {
    if (scheme === "socks5:" || scheme === "socks4:") {
      const { Socks5ProxyAgent, setGlobalDispatcher } = await import("undici");
      const setDispatcher = overrides?.setDispatcher ?? setGlobalDispatcher;
      setDispatcher(new Socks5ProxyAgent(url));
    } else if (scheme === "http:" || scheme === "https:") {
      const { ProxyAgent, setGlobalDispatcher } = await import("undici");
      const setDispatcher = overrides?.setDispatcher ?? setGlobalDispatcher;
      setDispatcher(new ProxyAgent(url));
    } else {
      console.warn(
        `[ClawRouter] Unsupported proxy scheme "${scheme}" in BLOCKRUN_UPSTREAM_PROXY — use http:// or socks5://`,
      );
      return undefined;
    }
  } catch (err) {
    console.warn(
      `[ClawRouter] Failed to configure upstream proxy "${url}": ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }

  return url;
}

/**
 * Honor standard proxy env vars when BLOCKRUN_UPSTREAM_PROXY is absent.
 * Loopback hosts are always excluded from proxying so local health checks
 * and sibling proxies on 127.0.0.1 stay direct.
 */
async function applyEnvProxyFallback(
  env: Record<string, string | undefined>,
  overrides?: UpstreamProxyOverrides,
): Promise<string | undefined> {
  const url = firstEnv(
    env,
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  );
  if (!url) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.warn(`[ClawRouter] Invalid proxy URL in environment: ${url} — skipping proxy setup`);
    return undefined;
  }

  if (parsed.protocol === "socks5:" || parsed.protocol === "socks4:") {
    console.warn(
      `[ClawRouter] SOCKS proxy found in environment but only applied when explicit — set BLOCKRUN_UPSTREAM_PROXY=${url} to route upstream traffic through it`,
    );
    return undefined;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    console.warn(
      `[ClawRouter] Unsupported proxy scheme "${parsed.protocol}" in environment — use http:// or set BLOCKRUN_UPSTREAM_PROXY`,
    );
    return undefined;
  }

  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
    const setDispatcher = overrides?.setDispatcher ?? setGlobalDispatcher;
    const httpProxy = firstEnv(env, "HTTP_PROXY", "http_proxy") ?? url;
    const httpsProxy = firstEnv(env, "HTTPS_PROXY", "https_proxy") ?? url;
    const noProxy = [firstEnv(env, "NO_PROXY", "no_proxy"), "localhost", "127.0.0.1", "::1"]
      .filter(Boolean)
      .join(",");
    setDispatcher(new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy }));
  } catch (err) {
    console.warn(
      `[ClawRouter] Failed to configure env proxy "${url}": ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }

  return url;
}
