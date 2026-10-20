import { describe, expect, it, vi } from "vitest";
import { removeRuntimeMcpConfig, setRuntimeProviderConfig } from "./index.js";

describe("runtime provider config", () => {
  it("does not throw when OpenClaw exposes a frozen config", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const config = Object.freeze({
      models: Object.freeze({
        providers: Object.freeze({
          blockrun: Object.freeze({ baseUrl: "https://configured.example/v1" }),
        }),
      }),
    });

    expect(() =>
      setRuntimeProviderConfig(
        { config, logger } as unknown as import("./types.js").OpenClawPluginApi,
        8402,
      ),
    ).not.toThrow();
    expect(config.models.providers.blockrun.baseUrl).toBe("https://configured.example/v1");
    expect(logger.debug).toHaveBeenCalledWith(
      "OpenClaw runtime config is read-only; using the persisted BlockRun provider config",
    );
  });

  it("updates a mutable config for immediate availability", () => {
    const config = { models: { providers: {} as Record<string, unknown> } };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    setRuntimeProviderConfig(
      { config, logger } as unknown as import("./types.js").OpenClawPluginApi,
      8402,
    );

    expect(config.models.providers.blockrun).toMatchObject({
      baseUrl: "http://127.0.0.1:8402/v1",
      api: "openai-completions",
      apiKey: "x402-proxy-handles-auth",
    });
  });

  it("retains an explicit legacy model in mutable runtime config", () => {
    const config = {
      models: { providers: {} as Record<string, unknown> },
      agents: { defaults: { model: "blockrun/minimax-m2.7" } },
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    setRuntimeProviderConfig(
      { config, logger } as unknown as import("./types.js").OpenClawPluginApi,
      8402,
    );

    expect(config.models.providers.blockrun).toMatchObject({
      models: expect.arrayContaining([expect.objectContaining({ id: "minimax-m2.7" })]),
    });
    expect(config.agents.defaults.model).toBe("blockrun/minimax-m2.7");
  });

  it("skips managed MCP cleanup when the runtime config is frozen", () => {
    const config = Object.freeze({
      mcp: Object.freeze({
        servers: Object.freeze({
          blockrun: Object.freeze({
            command: "npx",
            args: ["-y", "@blockrun/mcp@latest"],
          }),
        }),
      }),
    });
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    expect(
      removeRuntimeMcpConfig({
        config,
        logger,
      } as unknown as import("./types.js").OpenClawPluginApi),
    ).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(
      "OpenClaw runtime MCP config is read-only; skipping managed MCP cleanup",
    );
  });
});
