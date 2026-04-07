/**
 * /exclude command — manage excluded models.
 * Extracted from index.ts for modularity.
 */
import type { OpenClawPluginCommandDefinition, PluginCommandContext } from "../types.js";
import {
  loadExcludeList,
  addExclusion,
  removeExclusion,
  clearExclusions,
} from "../exclude-models.js";

export function createExcludeCommand(): OpenClawPluginCommandDefinition {
  return {
    name: "exclude",
    description: "Manage excluded models — /exclude add|remove|clear <model>",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: PluginCommandContext) => {
      const args = ctx.args?.trim() || "";
      const parts = args.split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() || "";
      const modelArg = parts.slice(1).join(" ").trim();

      // /exclude (no args) — show current list
      if (!subcommand) {
        const list = loadExcludeList();
        if (list.size === 0) {
          return {
            text: "No models excluded.\n\nUsage:\n  /exclude add <model>  — block a model\n  /exclude remove <model> — unblock\n  /exclude clear — remove all",
          };
        }
        const models = [...list]
          .sort()
          .map((m) => `  • ${m}`)
          .join("\n");
        return {
          text: `Excluded models (${list.size}):\n${models}\n\nUse /exclude remove <model> to unblock.`,
        };
      }

      // /exclude add <model>
      if (subcommand === "add") {
        if (!modelArg) {
          return {
            text: "Usage: /exclude add <model>\nExample: /exclude add nvidia/gpt-oss-120b",
            isError: true,
          };
        }
        const resolved = addExclusion(modelArg);
        const list = loadExcludeList();
        return {
          text: `Excluded: ${resolved}\n\nActive exclusions (${list.size}):\n${[...list]
            .sort()
            .map((m) => `  • ${m}`)
            .join("\n")}`,
        };
      }

      // /exclude remove <model>
      if (subcommand === "remove") {
        if (!modelArg) {
          return { text: "Usage: /exclude remove <model>", isError: true };
        }
        const removed = removeExclusion(modelArg);
        if (!removed) {
          return { text: `Model "${modelArg}" was not in the exclude list.` };
        }
        const list = loadExcludeList();
        return {
          text: `Unblocked: ${modelArg}\n\nActive exclusions (${list.size}):\n${
            list.size > 0
              ? [...list]
                  .sort()
                  .map((m) => `  • ${m}`)
                  .join("\n")
              : "  (none)"
          }`,
        };
      }

      // /exclude clear
      if (subcommand === "clear") {
        clearExclusions();
        return { text: "All model exclusions cleared." };
      }

      return {
        text: `Unknown subcommand: ${subcommand}\n\nUsage:\n  /exclude — show list\n  /exclude add <model>\n  /exclude remove <model>\n  /exclude clear`,
        isError: true,
      };
    },
  };
}
