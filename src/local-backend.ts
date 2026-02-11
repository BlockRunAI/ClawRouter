/**
 * Local Backend Support for ClawRouter
 * 
 * Allows routing Anthropic models to local Claude CLI instead of x402 payments.
 * This is useful for users with Claude Pro/Max subscriptions who want to use
 * their existing CLI authentication for Claude models while using ClawRouter
 * for other providers.
 * 
 * Configuration in openclaw.json:
 * {
 *   "plugins": {
 *     "entries": {
 *       "clawrouter": {
 *         "localBackends": {
 *           "claude": {
 *             "enabled": true,
 *             "command": "/path/to/claude",
 *             "args": ["--output-format", "json"]
 *           }
 *         }
 *       }
 *     }
 *   }
 * }
 */

import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface LocalBackendConfig {
  enabled: boolean;
  command: string;
  args?: string[];
}

export interface LocalBackendsConfig {
  claude?: LocalBackendConfig;
}

/**
 * Check if a model should be handled by a local backend.
 * Returns the backend config if applicable, undefined otherwise.
 */
export function getLocalBackend(
  modelId: string,
  config?: LocalBackendsConfig
): LocalBackendConfig | undefined {
  if (!config) return undefined;

  // Check if this is an Anthropic model and Claude backend is enabled
  if (config.claude?.enabled) {
    const isAnthropicModel = 
      modelId.startsWith("anthropic/") ||
      modelId === "claude" ||
      modelId === "sonnet" ||
      modelId === "opus" ||
      modelId === "haiku";
    
    if (isAnthropicModel) {
      return config.claude;
    }
  }

  return undefined;
}

/**
 * Handle a request using the local Claude CLI backend.
 * Converts OpenAI-format request to Claude CLI call and back.
 */
export async function handleLocalClaudeRequest(
  body: Buffer,
  backend: LocalBackendConfig,
  res: ServerResponse,
  logger: { info: (msg: string) => void; error: (msg: string) => void }
): Promise<void> {
  return new Promise((resolve) => {
    try {
      const parsed = JSON.parse(body.toString()) as {
        model?: string;
        messages?: Array<{ role: string; content: string }>;
        max_tokens?: number;
        stream?: boolean;
      };

      // Extract the last user message as the prompt
      const messages = parsed.messages || [];
      const prompt = messages
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n\n");

      // Build Claude CLI arguments
      const args = [...(backend.args || [])];
      args.push("--print"); // Output only the response
      
      // Map model name to Claude CLI model
      const modelMap: Record<string, string> = {
        "anthropic/claude-sonnet-4": "claude-sonnet-4-20250514",
        "anthropic/claude-opus-4": "claude-opus-4-20250514",
        "anthropic/claude-opus-4.5": "claude-opus-4-20250514",
        "anthropic/claude-haiku-4.5": "claude-haiku-4-20250514",
        "sonnet": "claude-sonnet-4-20250514",
        "opus": "claude-opus-4-20250514",
        "haiku": "claude-haiku-4-20250514",
        "claude": "claude-sonnet-4-20250514",
      };
      
      const cliModel = modelMap[parsed.model || ""] || "claude-sonnet-4-20250514";
      args.push("--model", cliModel);

      logger.info(`[LocalBackend] Routing to Claude CLI: ${backend.command} ${args.join(" ")}`);

      const child = spawn(backend.command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120000, // 2 minute timeout
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      // Handle stdin errors (EPIPE if child exits before write completes)
      child.stdin.on("error", (err) => {
        logger.error(`[LocalBackend] stdin error: ${err.message}`);
      });

      // Send the prompt to stdin
      child.stdin.write(prompt);
      child.stdin.end();

      child.on("close", (code) => {
        if (code !== 0) {
          logger.error(`[LocalBackend] Claude CLI failed (code ${code}): ${stderr}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: {
              message: `Claude CLI failed: ${stderr || "Unknown error"}`,
              type: "local_backend_error",
            },
          }));
          resolve();
          return;
        }

        // Build OpenAI-compatible response
        const response = {
          id: `chatcmpl-local-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: parsed.model || "claude-cli",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: stdout.trim(),
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
          _local_backend: true, // Flag to indicate this was handled locally
        };

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
        logger.info(`[LocalBackend] Claude CLI response delivered (${stdout.length} chars)`);
        resolve();
      });

      child.on("error", (err) => {
        logger.error(`[LocalBackend] Claude CLI spawn error: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: {
            message: `Failed to spawn Claude CLI: ${err.message}`,
            type: "local_backend_error",
          },
        }));
        resolve();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[LocalBackend] Error: ${message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: `Local backend error: ${message}`,
          type: "local_backend_error",
        },
      }));
      resolve();
    }
  });
}
