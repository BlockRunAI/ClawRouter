/**
 * Partner Tool Builder
 *
 * Converts partner service definitions into OpenClaw tool definitions.
 * Each tool's execute() calls through the local proxy which handles
 * x402 payment transparently using the same wallet.
 */

import { PARTNER_SERVICES, type PartnerServiceDefinition } from "./registry.js";

/** OpenClaw tool definition shape (duck-typed) */
export type PartnerToolDefinition = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Build a single partner tool from a service definition.
 */
function buildTool(service: PartnerServiceDefinition, proxyBaseUrl: string): PartnerToolDefinition {
  // Build JSON Schema properties from service params
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of service.params) {
    const prop: Record<string, unknown> = {
      description: param.description,
    };

    if (param.type === "string[]") {
      prop.type = "array";
      prop.items = { type: "string" };
    } else {
      prop.type = param.type;
    }

    properties[param.name] = prop;
    if (param.required) {
      required.push(param.name);
    }
  }

  return {
    name: `blockrun_${service.id}`,
    description: [
      service.description,
      "",
      `Partner: ${service.partner}`,
      `Pricing: ${service.pricing.perUnit} per ${service.pricing.unit} (min: ${service.pricing.minimum}, max: ${service.pricing.maximum})`,
    ].join("\n"),
    parameters: {
      type: "object",
      properties,
      required,
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      let path: string;
      const leftoverParams: Record<string, unknown> = {};
      let dynamicMethod: "GET" | "POST" = "GET";
      let dynamicBody: unknown = undefined;

      if (service.proxyPath === "/pm/__dynamic__") {
        // Dynamic-path tool: caller supplies `path`, optional `method`, `query`, `body`.
        // Validate `path` to prevent escaping the /pm namespace via leading-slash tricks.
        const rawPath = typeof params.path === "string" ? params.path : "";
        const normalized = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
        // Check the path as the URL parser will resolve it: `%2e%2e` decodes
        // to `..` there, so a literal-string check alone lets /pm/%2e%2e/voice/call
        // escape to /v1/voice/call.
        let resolved: string;
        try {
          resolved = new URL(`/v1${normalized}`, "http://x").pathname;
        } catch {
          resolved = "";
        }
        if (
          !normalized.startsWith("/pm/") ||
          normalized.includes("..") ||
          /%2e|%2f|%5c|\\/i.test(normalized) ||
          !resolved.startsWith("/v1/pm/")
        ) {
          throw new Error(
            `predexon_endpoint_call: invalid path '${rawPath}' — must begin with '/pm/' and contain no '..'`,
          );
        }
        path = `/v1${normalized}`;

        if (typeof params.method === "string") {
          const upper = params.method.toUpperCase();
          if (upper !== "GET" && upper !== "POST") {
            throw new Error(
              `predexon_endpoint_call: method must be 'GET' or 'POST', got '${params.method}'`,
            );
          }
          dynamicMethod = upper;
        }

        if (typeof params.query === "string" && params.query.trim().length > 0) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(params.query);
          } catch (err) {
            throw new Error(
              `predexon_endpoint_call: query must be a JSON object string — ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
          }
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
              if (value === undefined || value === null) continue;
              leftoverParams[key] = value;
            }
          }
        } else if (
          params.query &&
          typeof params.query === "object" &&
          !Array.isArray(params.query)
        ) {
          // Some tool runners forward the parsed object directly even though schema says string.
          for (const [key, value] of Object.entries(params.query as Record<string, unknown>)) {
            if (value === undefined || value === null) continue;
            leftoverParams[key] = value;
          }
        }

        if (dynamicMethod === "POST") {
          if (typeof params.body === "string" && params.body.trim().length > 0) {
            try {
              dynamicBody = JSON.parse(params.body);
            } catch (err) {
              throw new Error(
                `predexon_endpoint_call: body must be a JSON object string — ${err instanceof Error ? err.message : String(err)}`,
                { cause: err },
              );
            }
          } else if (params.body && typeof params.body === "object") {
            dynamicBody = params.body;
          } else {
            dynamicBody = {};
          }
        }
      } else {
        // Standard tool: substitute :pathParam placeholders, remaining params → query/body.
        path = `/v1${service.proxyPath}`;

        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null) continue;
          const placeholder = `:${key}`;
          if (path.includes(placeholder)) {
            path = path.replace(placeholder, encodeURIComponent(String(value)));
          } else {
            leftoverParams[key] = value;
          }
        }
      }

      const effectiveMethod =
        service.proxyPath === "/pm/__dynamic__" ? dynamicMethod : service.method;

      let url = `${proxyBaseUrl}${path}`;
      if (effectiveMethod === "GET" && Object.keys(leftoverParams).length > 0) {
        const qs = new URLSearchParams();
        for (const [key, value] of Object.entries(leftoverParams)) {
          qs.set(key, Array.isArray(value) ? value.join(",") : String(value));
        }
        url += `?${qs.toString()}`;
      }

      let requestBody: string | undefined;
      if (effectiveMethod === "POST") {
        if (service.proxyPath === "/pm/__dynamic__") {
          requestBody = JSON.stringify(dynamicBody ?? {});
        } else {
          requestBody = JSON.stringify(params);
        }
      }

      const response = await fetch(url, {
        method: effectiveMethod,
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(
          `Partner API error (${response.status}): ${errText || response.statusText}`,
        );
      }

      const data = await response.json();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
        details: data,
      };
    },
  };
}

/**
 * Build OpenClaw tool definitions for all registered partner services.
 * @param proxyBaseUrl - Local proxy base URL (e.g., "http://127.0.0.1:8402")
 */
export function buildPartnerTools(proxyBaseUrl: string): PartnerToolDefinition[] {
  return PARTNER_SERVICES.map((service) => buildTool(service, proxyBaseUrl));
}
