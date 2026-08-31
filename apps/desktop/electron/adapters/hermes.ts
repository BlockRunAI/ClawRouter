import { dirname, join } from "node:path";

import { hasHermesConfig, removeHermesConfig } from "../core/config.js";
import { fileExists, readText } from "../core/files.js";
import { findCommand } from "../core/runtime.js";
import type { AdapterContext, AgentAdapter, AgentStatus, InstallOptions } from "../core/types.js";
import { assertCommand, statusShape } from "./shared.js";

export class HermesAdapter implements AgentAdapter {
  readonly id = "hermes" as const;
  readonly name = "Hermes";
  readonly description = "Hermes model-provider plugin backed by the local ClawRouter proxy.";
  readonly activation = "restart-agent" as const;

  managedPaths(context: AdapterContext): string[] {
    return [
      join(context.homeDir, ".hermes", "config.yaml"),
      join(context.homeDir, ".hermes", ".env"),
    ];
  }

  async status(context: AdapterContext): Promise<AgentStatus> {
    const config = await readText(this.managedPaths(context)[0]!);
    const hermes = await findCommand(context, "hermes");
    return statusShape({
      context,
      id: this.id,
      name: this.name,
      description: this.description,
      installed: Boolean(hermes),
      configured: hasHermesConfig(config),
      activation: this.activation,
      restartRequired: hasHermesConfig(config),
      details: hermes
        ? hasHermesConfig(config)
          ? ["Restart the current Hermes process after changing this connection."]
          : []
        : ["Install Hermes before enabling the provider."],
    });
  }

  async disconnect(context: AdapterContext): Promise<void> {
    const [configPath, envPath] = this.managedPaths(context);
    await removeHermesConfig(configPath!, envPath!);
  }

  async install(context: AdapterContext, options: InstallOptions): Promise<void> {
    if (!(await findCommand(context, "hermes")))
      throw new Error("Hermes CLI was not found on PATH");
    let plugin = await findCommand(context, "hermes-clawrouter");
    if (!plugin) {
      const venvPython = join(context.homeDir, ".hermes", "hermes-agent", "venv", "bin", "python");
      const python = (await fileExists(venvPython)) ? venvPython : "python3";
      const install = await context.runCommand(
        python,
        ["-m", "pip", "install", "hermes-plugin-clawrouter"],
        {
          timeoutMs: 180_000,
        },
      );
      assertCommand(install, "Hermes ClawRouter plugin install");
      plugin = await findCommand(context, "hermes-clawrouter");
      if (!plugin && python === venvPython) plugin = join(dirname(venvPython), "hermes-clawrouter");
    }
    const args = ["setup", "--force"];
    if (options.setDefault ?? true) args.push("--set-default");
    const setup = await context.runCommand(plugin ?? "hermes-clawrouter", args, {
      env: { ...process.env, HOME: context.homeDir, HERMES_HOME: join(context.homeDir, ".hermes") },
      timeoutMs: 180_000,
    });
    assertCommand(setup, "Hermes setup");
  }

  async verify(context: AdapterContext): Promise<{ ok: boolean; details: string[] }> {
    const [config, env] = await Promise.all(
      this.managedPaths(context).map((path) => readText(path)),
    );
    const provider = /providers:\s*[\s\S]*clawrouter:/m.test(config);
    const key = /^CLAWROUTER_API_KEY=/m.test(env);
    return {
      ok: provider && key,
      details: [
        provider ? "Hermes provider registered" : "Hermes provider missing",
        key ? "Local discovery key present" : "Local discovery key missing",
      ],
    };
  }
}
