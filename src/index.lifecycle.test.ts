import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Drain the microtask queue.
 *
 * These tests used to flush with a fixed pair of `await Promise.resolve()`,
 * which pins the exact number of awaits inside startProxyInBackground — adding
 * one (resolving the BlockRun API key before any wallet is touched, v0.12.268)
 * broke four of them without changing any behaviour they test. Draining until
 * quiet keeps the assertions about ordering instead of about await counts.
 * Fake timers are unaffected: this advances no clock.
 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock("node:net", () => ({
  connect: vi.fn(() => {
    const handlers: Record<string, (() => void) | undefined> = {};
    const socket = {
      destroy: vi.fn(),
      on: vi.fn((event: string, handler: () => void) => {
        handlers[event] = handler;
        return socket;
      }),
      setTimeout: vi.fn(() => socket),
    };
    setTimeout(() => handlers.error?.(), 0);
    return socket;
  }),
}));

describe("plugin lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    const proc = process as NodeJS.Process & {
      __clawrouterProxyStarted?: boolean;
      __clawrouterDeferredStartTimer?: ReturnType<typeof setTimeout>;
      __clawrouterStartupGeneration?: number;
      __clawrouterStartedWithEmptyConfig?: boolean;
      __clawrouterStartupPhase?: "idle" | "probing" | "starting" | "running";
      __clawrouterSharedSpendControl?: unknown;
    };
    proc.__clawrouterProxyStarted = undefined;
    proc.__clawrouterDeferredStartTimer = undefined;
    proc.__clawrouterStartupGeneration = undefined;
    proc.__clawrouterStartedWithEmptyConfig = undefined;
    proc.__clawrouterStartupPhase = undefined;
    proc.__clawrouterSharedSpendControl = undefined;
  });

  it("clears deferred proxy startup state during deactivate", async () => {
    vi.useFakeTimers();

    const { default: plugin } = await import("./index.js");
    const proc = process as NodeJS.Process & {
      __clawrouterProxyStarted?: boolean;
      __clawrouterDeferredStartTimer?: ReturnType<typeof setTimeout>;
    };

    let fired = false;
    proc.__clawrouterProxyStarted = true;
    proc.__clawrouterDeferredStartTimer = setTimeout(() => {
      fired = true;
    }, 250);

    plugin.deactivate?.({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as unknown as import("./types.js").OpenClawPluginApi);

    await vi.advanceTimersByTimeAsync(300);

    expect(fired).toBe(false);
    expect(proc.__clawrouterProxyStarted).toBe(false);
    expect(proc.__clawrouterDeferredStartTimer).toBeUndefined();
  });

  it("connects /policy to the process-wide ledger when another module owns the proxy", async () => {
    const { InMemorySpendControlStorage, SpendControl, setSharedSpendControl } =
      await import("./spend-control.js");
    const shared = new SpendControl({ storage: new InMemorySpendControlStorage() });
    shared.setLimit("daily", 7);
    setSharedSpendControl(shared);

    const proc = process as NodeJS.Process & { __clawrouterProxyStarted?: boolean };
    proc.__clawrouterProxyStarted = true;
    const commands: import("./types.js").OpenClawPluginCommandDefinition[] = [];
    const api = {
      id: "duplicate-module",
      name: "duplicate-module",
      source: "local",
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerProvider: vi.fn(),
      registerImageGenerationProvider: vi.fn(),
      registerMusicGenerationProvider: vi.fn(),
      registerWebSearchProvider: vi.fn(),
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerService: vi.fn(),
      registerCommand: vi.fn((command) => commands.push(command)),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as unknown as import("./types.js").OpenClawPluginApi;

    const { default: plugin } = await import("./index.js");
    plugin.register?.(api);
    const policy = commands.find((command) => command.name === "policy");
    expect(policy).toBeDefined();
    const result = await policy!.handler({
      channel: "test",
      isAuthorizedSender: true,
      commandBody: "",
      args: "",
      config: {},
    });
    expect(result.text).toContain("daily: $7");
  });

  it("restarts a provisional default-config proxy when populated pluginConfig arrives later", async () => {
    vi.useFakeTimers();

    const firstClose = vi.fn(async () => {});
    const secondClose = vi.fn(async () => {});
    const startProxy = vi
      .fn()
      .mockResolvedValueOnce({
        close: firstClose,
        balanceMonitor: {
          checkBalance: vi.fn(async () => ({ isEmpty: true, isLow: false, balanceUSD: "0.00" })),
        },
      })
      .mockResolvedValueOnce({
        close: secondClose,
        balanceMonitor: {
          checkBalance: vi.fn(async () => ({ isEmpty: true, isLow: false, balanceUSD: "0.00" })),
        },
      });

    vi.doMock("./proxy.js", () => ({
      getProxyPort: () => 8402,
      startProxy,
    }));
    vi.doMock("./api-key.js", () => ({
      resolveApiKey: vi.fn(async () => undefined),
      isValidApiKey: (v: unknown) => typeof v === "string" && v.startsWith("brk_"),
      maskApiKey: (v: string) => v,
      PORTAL_CREDITS_URL: "https://user.blockrun.ai/dashboard/credits",
      PORTAL_KEYS_URL: "https://user.blockrun.ai/dashboard/keys",
    }));
    vi.doMock("./auth.js", () => ({
      resolveOrGenerateWalletKey: vi.fn(async () => ({
        key: "0x1234567890123456789012345678901234567890123456789012345678901234",
        address: "0x1111111111111111111111111111111111111111",
        source: "saved",
      })),
      setupSolana: vi.fn(),
      savePaymentChain: vi.fn(),
      resolvePaymentChain: vi.fn(async () => "base"),
      WALLET_FILE: "/tmp/wallet",
      MNEMONIC_FILE: "/tmp/mnemonic",
    }));
    vi.doMock("./provider.js", () => ({
      blockrunProvider: { id: "blockrun" },
      setActiveProxy: vi.fn(),
    }));
    vi.doMock("./models.js", () => ({
      OPENCLAW_MODELS: [],
      VISIBLE_OPENCLAW_MODELS: [],
    }));
    vi.doMock("./web-search-provider.js", () => ({
      BLOCKRUN_EXA_PROVIDER_ID: "blockrun-exa",
      blockrunExaWebSearchProvider: { id: "blockrun-exa" },
    }));
    vi.doMock("./partners/index.js", () => ({
      buildPartnerTools: vi.fn(() => []),
      PARTNER_SERVICES: [],
    }));
    vi.doMock("./commands/stats.js", () => ({
      createStatsCommand: vi.fn(() => ({ name: "stats", handler: vi.fn() })),
    }));
    vi.doMock("./commands/exclude.js", () => ({
      createExcludeCommand: vi.fn(() => ({ name: "exclude", handler: vi.fn() })),
    }));
    vi.doMock("./mcp-config.js", () => ({
      BLOCKRUN_MCP_SERVER_NAME: "blockrun",
      createBlockrunMcpServerDefinition: vi.fn(() => ({ command: "npx", args: [] })),
      ensureBlockrunMcpServerConfig: vi.fn(() => ({ changed: false, status: "preserved" })),
      removeManagedBlockrunMcpServerConfig: vi.fn(),
    }));
    vi.doMock("./version.js", () => ({
      VERSION: "test",
    }));
    vi.doMock("./exclude-models.js", () => ({
      loadExcludeList: vi.fn(() => new Set()),
    }));

    const createApi = (pluginConfig: Record<string, unknown>) =>
      ({
        id: "test",
        name: "test",
        source: "local",
        config: {},
        pluginConfig,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        registerProvider: vi.fn(),
        registerImageGenerationProvider: vi.fn(),
        registerMusicGenerationProvider: vi.fn(),
        registerWebSearchProvider: vi.fn(),
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerService: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      }) as unknown as import("./types.js").OpenClawPluginApi;

    const originalArgv = process.argv;
    process.argv = [...originalArgv, "gateway"];

    try {
      const { default: plugin } = await import("./index.js");
      const emptyApi = createApi({});
      const configuredRouting = {
        tiers: {
          SIMPLE: { primary: "configured-model", fallback: [] },
        },
      };
      const configuredApi = createApi({
        routing: configuredRouting,
      });

      plugin.register?.(emptyApi);
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      expect(startProxy).toHaveBeenCalledTimes(1);
      expect(startProxy.mock.calls[0]?.[0]?.routingConfig).toBeUndefined();

      plugin.register?.(configuredApi);
      await vi.runAllTimersAsync();
      await flush();

      expect(firstClose).toHaveBeenCalledTimes(1);
      expect(startProxy).toHaveBeenCalledTimes(2);
      expect(startProxy.mock.calls[1]?.[0]?.routingConfig).toEqual(configuredRouting);
      expect(secondClose).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
    }
  });

  it("restarts the queued configured proxy when provisional startup rejects after being superseded", async () => {
    vi.useFakeTimers();

    let rejectFirstStart!: (reason?: unknown) => void;
    const secondClose = vi.fn(async () => {});
    const startProxy = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirstStart = reject;
          }),
      )
      .mockResolvedValueOnce({
        close: secondClose,
        balanceMonitor: {
          checkBalance: vi.fn(async () => ({ isEmpty: true, isLow: false, balanceUSD: "0.00" })),
        },
      });

    vi.doMock("./proxy.js", () => ({
      getProxyPort: () => 8402,
      startProxy,
    }));
    vi.doMock("./api-key.js", () => ({
      resolveApiKey: vi.fn(async () => undefined),
      isValidApiKey: (v: unknown) => typeof v === "string" && v.startsWith("brk_"),
      maskApiKey: (v: string) => v,
      PORTAL_CREDITS_URL: "https://user.blockrun.ai/dashboard/credits",
      PORTAL_KEYS_URL: "https://user.blockrun.ai/dashboard/keys",
    }));
    vi.doMock("./auth.js", () => ({
      resolveOrGenerateWalletKey: vi.fn(async () => ({
        key: "0x1234567890123456789012345678901234567890123456789012345678901234",
        address: "0x1111111111111111111111111111111111111111",
        source: "saved",
      })),
      setupSolana: vi.fn(),
      savePaymentChain: vi.fn(),
      resolvePaymentChain: vi.fn(async () => "base"),
      WALLET_FILE: "/tmp/wallet",
      MNEMONIC_FILE: "/tmp/mnemonic",
    }));
    vi.doMock("./provider.js", () => ({
      blockrunProvider: { id: "blockrun" },
      setActiveProxy: vi.fn(),
    }));
    vi.doMock("./models.js", () => ({
      OPENCLAW_MODELS: [],
      VISIBLE_OPENCLAW_MODELS: [],
    }));
    vi.doMock("./web-search-provider.js", () => ({
      BLOCKRUN_EXA_PROVIDER_ID: "blockrun-exa",
      blockrunExaWebSearchProvider: { id: "blockrun-exa" },
    }));
    vi.doMock("./partners/index.js", () => ({
      buildPartnerTools: vi.fn(() => []),
      PARTNER_SERVICES: [],
    }));
    vi.doMock("./commands/stats.js", () => ({
      createStatsCommand: vi.fn(() => ({ name: "stats", handler: vi.fn() })),
    }));
    vi.doMock("./commands/exclude.js", () => ({
      createExcludeCommand: vi.fn(() => ({ name: "exclude", handler: vi.fn() })),
    }));
    vi.doMock("./mcp-config.js", () => ({
      BLOCKRUN_MCP_SERVER_NAME: "blockrun",
      createBlockrunMcpServerDefinition: vi.fn(() => ({ command: "npx", args: [] })),
      ensureBlockrunMcpServerConfig: vi.fn(() => ({ changed: false, status: "preserved" })),
      removeManagedBlockrunMcpServerConfig: vi.fn(),
    }));
    vi.doMock("./version.js", () => ({
      VERSION: "test",
    }));
    vi.doMock("./exclude-models.js", () => ({
      loadExcludeList: vi.fn(() => new Set()),
    }));

    const createApi = (pluginConfig: Record<string, unknown>) =>
      ({
        id: "test",
        name: "test",
        source: "local",
        config: {},
        pluginConfig,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        registerProvider: vi.fn(),
        registerImageGenerationProvider: vi.fn(),
        registerMusicGenerationProvider: vi.fn(),
        registerWebSearchProvider: vi.fn(),
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerService: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      }) as unknown as import("./types.js").OpenClawPluginApi;

    const originalArgv = process.argv;
    process.argv = [...originalArgv, "gateway"];

    try {
      const { default: plugin } = await import("./index.js");
      const emptyApi = createApi({});
      const configuredRouting = {
        tiers: {
          SIMPLE: { primary: "configured-model", fallback: [] },
        },
      };
      const configuredApi = createApi({
        routing: configuredRouting,
      });

      plugin.register?.(emptyApi);
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      expect(startProxy).toHaveBeenCalledTimes(1);

      plugin.register?.(configuredApi);
      expect(startProxy).toHaveBeenCalledTimes(1);

      rejectFirstStart(new Error("provisional startup failed"));
      await vi.runAllTimersAsync();
      await flush();

      expect(startProxy).toHaveBeenCalledTimes(2);
      expect(startProxy.mock.calls[1]?.[0]?.routingConfig).toEqual(configuredRouting);
      expect(secondClose).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
    }
  });

  it("keeps the newest populated pluginConfig when a later register arrives before provisional startup settles", async () => {
    vi.useFakeTimers();

    const firstClose = vi.fn(async () => {});
    const secondClose = vi.fn(async () => {});
    let resolveFirstStart!: (value: {
      close: typeof firstClose;
      balanceMonitor: { checkBalance: ReturnType<typeof vi.fn> };
      solanaAddress?: string;
    }) => void;
    const startProxy = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstStart = resolve;
          }),
      )
      .mockResolvedValueOnce({
        close: secondClose,
        balanceMonitor: {
          checkBalance: vi.fn(async () => ({ isEmpty: true, isLow: false, balanceUSD: "0.00" })),
        },
      });

    vi.doMock("./proxy.js", () => ({
      getProxyPort: () => 8402,
      startProxy,
    }));
    vi.doMock("./api-key.js", () => ({
      resolveApiKey: vi.fn(async () => undefined),
      isValidApiKey: (v: unknown) => typeof v === "string" && v.startsWith("brk_"),
      maskApiKey: (v: string) => v,
      PORTAL_CREDITS_URL: "https://user.blockrun.ai/dashboard/credits",
      PORTAL_KEYS_URL: "https://user.blockrun.ai/dashboard/keys",
    }));
    vi.doMock("./auth.js", () => ({
      resolveOrGenerateWalletKey: vi.fn(async () => ({
        key: "0x1234567890123456789012345678901234567890123456789012345678901234",
        address: "0x1111111111111111111111111111111111111111",
        source: "saved",
      })),
      setupSolana: vi.fn(),
      savePaymentChain: vi.fn(),
      resolvePaymentChain: vi.fn(async () => "base"),
      WALLET_FILE: "/tmp/wallet",
      MNEMONIC_FILE: "/tmp/mnemonic",
    }));
    vi.doMock("./provider.js", () => ({
      blockrunProvider: { id: "blockrun" },
      setActiveProxy: vi.fn(),
    }));
    vi.doMock("./models.js", () => ({
      OPENCLAW_MODELS: [],
      VISIBLE_OPENCLAW_MODELS: [],
    }));
    vi.doMock("./web-search-provider.js", () => ({
      BLOCKRUN_EXA_PROVIDER_ID: "blockrun-exa",
      blockrunExaWebSearchProvider: { id: "blockrun-exa" },
    }));
    vi.doMock("./partners/index.js", () => ({
      buildPartnerTools: vi.fn(() => []),
      PARTNER_SERVICES: [],
    }));
    vi.doMock("./commands/stats.js", () => ({
      createStatsCommand: vi.fn(() => ({ name: "stats", handler: vi.fn() })),
    }));
    vi.doMock("./commands/exclude.js", () => ({
      createExcludeCommand: vi.fn(() => ({ name: "exclude", handler: vi.fn() })),
    }));
    vi.doMock("./mcp-config.js", () => ({
      BLOCKRUN_MCP_SERVER_NAME: "blockrun",
      createBlockrunMcpServerDefinition: vi.fn(() => ({ command: "npx", args: [] })),
      ensureBlockrunMcpServerConfig: vi.fn(() => ({ changed: false, status: "preserved" })),
      removeManagedBlockrunMcpServerConfig: vi.fn(),
    }));
    vi.doMock("./version.js", () => ({
      VERSION: "test",
    }));
    vi.doMock("./exclude-models.js", () => ({
      loadExcludeList: vi.fn(() => new Set()),
    }));

    const createApi = (pluginConfig: Record<string, unknown>) =>
      ({
        id: "test",
        name: "test",
        source: "local",
        config: {},
        pluginConfig,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        registerProvider: vi.fn(),
        registerImageGenerationProvider: vi.fn(),
        registerMusicGenerationProvider: vi.fn(),
        registerWebSearchProvider: vi.fn(),
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerService: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      }) as unknown as import("./types.js").OpenClawPluginApi;

    const originalArgv = process.argv;
    process.argv = [...originalArgv, "gateway"];

    try {
      const { default: plugin } = await import("./index.js");
      const emptyApi = createApi({});
      const configuredRoutingA = {
        tiers: {
          SIMPLE: { primary: "configured-model-a", fallback: [] },
        },
      };
      const configuredRoutingB = {
        tiers: {
          SIMPLE: { primary: "configured-model-b", fallback: [] },
        },
      };
      const configuredApiA = createApi({
        routing: configuredRoutingA,
      });
      const configuredApiB = createApi({
        routing: configuredRoutingB,
      });

      plugin.register?.(emptyApi);
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      expect(startProxy).toHaveBeenCalledTimes(1);

      plugin.register?.(configuredApiA);
      expect(startProxy).toHaveBeenCalledTimes(1);

      plugin.register?.(configuredApiB);
      await vi.runAllTimersAsync();
      await flush();

      expect(startProxy).toHaveBeenCalledTimes(2);
      expect(startProxy.mock.calls[1]?.[0]?.routingConfig).toEqual(configuredRoutingB);

      resolveFirstStart({
        close: firstClose,
        balanceMonitor: {
          checkBalance: vi.fn(async () => ({ isEmpty: true, isLow: false, balanceUSD: "0.00" })),
        },
      });
      await flush();

      expect(firstClose).toHaveBeenCalledTimes(1);
      expect(startProxy).toHaveBeenCalledTimes(2);
      expect(secondClose).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
    }
  });

  it("strips managed blockrun MCP server from api.config on register and does not re-inject", async () => {
    vi.doMock("./proxy.js", () => ({
      getProxyPort: () => 8402,
      startProxy: vi.fn(),
    }));
    vi.doMock("./api-key.js", () => ({
      resolveApiKey: vi.fn(async () => undefined),
      isValidApiKey: (v: unknown) => typeof v === "string" && v.startsWith("brk_"),
      maskApiKey: (v: string) => v,
      PORTAL_CREDITS_URL: "https://user.blockrun.ai/dashboard/credits",
      PORTAL_KEYS_URL: "https://user.blockrun.ai/dashboard/keys",
    }));
    vi.doMock("./auth.js", () => ({
      resolveOrGenerateWalletKey: vi.fn(async () => ({
        key: "0x1234567890123456789012345678901234567890123456789012345678901234",
        address: "0x1111111111111111111111111111111111111111",
        source: "saved",
      })),
      setupSolana: vi.fn(),
      savePaymentChain: vi.fn(),
      resolvePaymentChain: vi.fn(async () => "base"),
      WALLET_FILE: "/tmp/wallet",
      MNEMONIC_FILE: "/tmp/mnemonic",
    }));
    vi.doMock("./provider.js", () => ({
      blockrunProvider: { id: "blockrun" },
      setActiveProxy: vi.fn(),
    }));
    vi.doMock("./models.js", () => ({
      OPENCLAW_MODELS: [],
      VISIBLE_OPENCLAW_MODELS: [],
    }));
    vi.doMock("./web-search-provider.js", () => ({
      BLOCKRUN_EXA_PROVIDER_ID: "blockrun-exa",
      blockrunExaWebSearchProvider: { id: "blockrun-exa" },
    }));
    vi.doMock("./partners/index.js", () => ({
      buildPartnerTools: vi.fn(() => []),
      PARTNER_SERVICES: [],
    }));
    vi.doMock("./commands/stats.js", () => ({
      createStatsCommand: vi.fn(() => ({ name: "stats", handler: vi.fn() })),
    }));
    vi.doMock("./commands/exclude.js", () => ({
      createExcludeCommand: vi.fn(() => ({ name: "exclude", handler: vi.fn() })),
    }));
    vi.doMock("./version.js", () => ({
      VERSION: "test",
    }));
    vi.doMock("./exclude-models.js", () => ({
      loadExcludeList: vi.fn(() => new Set()),
    }));
    // Exercise the real ./mcp-config.js migration path. Override any
    // lingering doMock from earlier tests in this file by pointing back
    // at the actual implementation.
    vi.doMock("./mcp-config.js", async () => await vi.importActual("./mcp-config.js"));

    const { default: plugin } = await import("./index.js");

    const api = {
      id: "test",
      name: "test",
      source: "local",
      config: {
        mcp: {
          servers: {
            blockrun: {
              command: "npx",
              args: ["-y", "@blockrun/mcp@latest"],
              connectionTimeoutMs: 30_000,
            },
          },
        },
      },
      pluginConfig: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      registerProvider: vi.fn(),
      registerImageGenerationProvider: vi.fn(),
      registerMusicGenerationProvider: vi.fn(),
      registerWebSearchProvider: vi.fn(),
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerService: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as unknown as import("./types.js").OpenClawPluginApi;

    plugin.register?.(api);

    const runtimeConfig = api.config as import("./types.js").OpenClawConfig;
    expect(runtimeConfig.mcp?.servers).toBeUndefined();
  });

  it("closes stale in-flight proxy startups that finish after deactivate", async () => {
    vi.useFakeTimers();

    const close = vi.fn(async () => {});
    let resolveStart!: (value: {
      close: typeof close;
      balanceMonitor: { checkBalance: ReturnType<typeof vi.fn> };
      solanaAddress?: string;
    }) => void;

    vi.doMock("./proxy.js", () => ({
      getProxyPort: () => 8402,
      startProxy: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveStart = resolve;
          }),
      ),
    }));
    vi.doMock("./api-key.js", () => ({
      resolveApiKey: vi.fn(async () => undefined),
      isValidApiKey: (v: unknown) => typeof v === "string" && v.startsWith("brk_"),
      maskApiKey: (v: string) => v,
      PORTAL_CREDITS_URL: "https://user.blockrun.ai/dashboard/credits",
      PORTAL_KEYS_URL: "https://user.blockrun.ai/dashboard/keys",
    }));
    vi.doMock("./auth.js", () => ({
      resolveOrGenerateWalletKey: vi.fn(async () => ({
        key: "0x1234567890123456789012345678901234567890123456789012345678901234",
        address: "0x1111111111111111111111111111111111111111",
        source: "saved",
      })),
      setupSolana: vi.fn(),
      savePaymentChain: vi.fn(),
      resolvePaymentChain: vi.fn(async () => "base"),
      WALLET_FILE: "/tmp/wallet",
      MNEMONIC_FILE: "/tmp/mnemonic",
    }));
    vi.doMock("./provider.js", () => ({
      blockrunProvider: { id: "blockrun" },
      setActiveProxy: vi.fn(),
    }));
    vi.doMock("./models.js", () => ({
      OPENCLAW_MODELS: [],
      VISIBLE_OPENCLAW_MODELS: [],
    }));
    vi.doMock("./web-search-provider.js", () => ({
      BLOCKRUN_EXA_PROVIDER_ID: "blockrun-exa",
      blockrunExaWebSearchProvider: { id: "blockrun-exa" },
    }));
    vi.doMock("./partners/index.js", () => ({
      buildPartnerTools: vi.fn(() => []),
      PARTNER_SERVICES: [],
    }));
    vi.doMock("./commands/stats.js", () => ({
      createStatsCommand: vi.fn(() => ({ name: "stats", handler: vi.fn() })),
    }));
    vi.doMock("./commands/exclude.js", () => ({
      createExcludeCommand: vi.fn(() => ({ name: "exclude", handler: vi.fn() })),
    }));
    vi.doMock("./mcp-config.js", () => ({
      BLOCKRUN_MCP_SERVER_NAME: "blockrun",
      createBlockrunMcpServerDefinition: vi.fn(() => ({ command: "npx", args: [] })),
      ensureBlockrunMcpServerConfig: vi.fn(() => ({ changed: false, status: "preserved" })),
      removeManagedBlockrunMcpServerConfig: vi.fn(),
    }));
    vi.doMock("./version.js", () => ({
      VERSION: "test",
    }));
    vi.doMock("./exclude-models.js", () => ({
      loadExcludeList: vi.fn(() => new Set()),
    }));

    const originalArgv = process.argv;
    process.argv = [...originalArgv, "gateway"];

    try {
      const { default: plugin } = await import("./index.js");
      const api = {
        id: "test",
        name: "test",
        source: "local",
        config: {},
        pluginConfig: { routing: {} },
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        registerProvider: vi.fn(),
        registerImageGenerationProvider: vi.fn(),
        registerMusicGenerationProvider: vi.fn(),
        registerWebSearchProvider: vi.fn(),
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerService: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as unknown as import("./types.js").OpenClawPluginApi;

      plugin.register?.(api);
      await vi.runAllTimersAsync();
      expect(typeof resolveStart).toBe("function");

      plugin.deactivate?.(api);

      resolveStart({
        close,
        balanceMonitor: {
          checkBalance: vi.fn(async () => ({ isEmpty: true, isLow: false, balanceUSD: "0.00" })),
        },
      });

      await flush();

      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      process.argv = originalArgv;
    }
  });
});
