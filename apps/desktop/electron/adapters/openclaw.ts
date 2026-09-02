import { join } from "node:path";

import { hasOpenClawConfig, removeOpenClawConfig } from "../core/config.js";
import { readText } from "../core/files.js";
import { findCommand } from "../core/runtime.js";
import type { AdapterContext, AgentAdapter, AgentStatus, InstallOptions } from "../core/types.js";
import { assertCommand, statusShape } from "./shared.js";

export class OpenClawAdapter implements AgentAdapter {
  readonly id = "openclaw" as const;
  readonly name = "OpenClaw";
  readonly description = "Native ClawRouter plugin with chat, tools, wallet, and smart routing.";
  readonly activation = "restart-gateway" as const;

  managedPaths(context: AdapterContext): string[] {
    return [
      join(context.homeDir, ".openclaw", "openclaw.json"),
      join(context.homeDir, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
    ];
  }

  async status(context: AdapterContext): Promise<AgentStatus> {
    const config = await readText(this.managedPaths(context)[0]!);
    const installed = Boolean(await findCommand(context, "openclaw"));
    return statusShape({
      context,
      id: this.id,
      name: this.name,
      description: this.description,
      installed,
      configured: hasOpenClawConfig(config),
      activation: this.activation,
      restartRequired: hasOpenClawConfig(config),
      details: installed
        ? hasOpenClawConfig(config)
          ? ["Restart the OpenClaw gateway after changing this connection."]
          : []
        : ["Install OpenClaw before enabling its ClawRouter plugin."],
    });
  }

  async disconnect(context: AdapterContext): Promise<void> {
    const [configPath, authPath] = this.managedPaths(context);
    await removeOpenClawConfig(configPath!, authPath!);
  }

  async cleanupRuntime(context: AdapterContext): Promise<void> {
    if (!(await findCommand(context, "openclaw"))) return;
    const result = await context.runCommand(
      "openclaw",
      ["plugins", "uninstall", "--force", "blockrun-clawrouter"],
      { env: { ...process.env, HOME: context.homeDir }, timeoutMs: 60_000 },
    );
    if (result.code === 0) return;
    const output = `${result.stdout}\n${result.stderr}`;
    if (/not installed|not found|unknown plugin/i.test(output)) return;
    assertCommand(result, "BlockRun ClawRouter plugin uninstall");
  }

  async install(context: AdapterContext, _options: InstallOptions): Promise<void> {
    if (!(await findCommand(context, "openclaw")))
      throw new Error("OpenClaw CLI was not found on PATH");
    const result = await context.runCommand("npx", ["-y", "@blockrun/clawrouter@latest", "setup"], {
      env: { ...process.env, HOME: context.homeDir },
      timeoutMs: 180_000,
    });
    assertCommand(result, "ClawRouter setup");
  }

  async verify(context: AdapterContext): Promise<{ ok: boolean; details: string[] }> {
    const config = await readText(this.managedPaths(context)[0]!);
    const ok = hasOpenClawConfig(config);
    return {
      ok,
      details: [ok ? "OpenClaw provider config detected" : "OpenClaw provider config is missing"],
    };
  }
}
