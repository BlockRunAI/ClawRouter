import { join } from "node:path";

import { containsClawRouterConfig, upsertCodexConfig } from "../core/config.js";
import { readText } from "../core/files.js";
import { findCommand } from "../core/runtime.js";
import type { AdapterContext, AgentAdapter, AgentStatus, InstallOptions } from "../core/types.js";
import { statusShape } from "./shared.js";

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex" as const;
  readonly name = "Codex";
  readonly description = "Responses API bridge for Codex CLI and Codex Desktop.";
  readonly activation = "restart-agent" as const;

  managedPaths(context: AdapterContext): string[] {
    return [join(context.homeDir, ".codex", "config.toml")];
  }

  async status(context: AdapterContext): Promise<AgentStatus> {
    const config = await readText(this.managedPaths(context)[0]!);
    const configured =
      containsClawRouterConfig(config) && /model_providers\.clawrouter/.test(config);
    return statusShape({
      context,
      id: this.id,
      name: this.name,
      description: this.description,
      installed: Boolean(await findCommand(context, "codex")),
      configured,
      activation: this.activation,
      restartRequired: configured,
      details: configured
        ? ["Restart Codex CLI or Codex Desktop after changing this connection."]
        : [],
    });
  }

  async install(context: AdapterContext, options: InstallOptions): Promise<void> {
    if (!(await findCommand(context, "codex"))) throw new Error("Codex CLI was not found on PATH");
    await upsertCodexConfig(
      this.managedPaths(context)[0]!,
      "http://127.0.0.1:8403/v1",
      options.model ?? "blockrun/auto",
      options.setDefault ?? true,
    );
  }

  async verify(context: AdapterContext): Promise<{ ok: boolean; details: string[] }> {
    const config = await readText(this.managedPaths(context)[0]!);
    const provider = /\[model_providers\.clawrouter\]/.test(config);
    const base = /base_url\s*=\s*["']http:\/\/127\.0\.0\.1:8403\/v1/.test(config);
    return {
      ok: provider && base,
      details: [
        provider ? "Codex provider table detected" : "Codex provider table missing",
        base ? "Bridge URL is correct" : "Bridge URL is incorrect",
      ],
    };
  }
}
