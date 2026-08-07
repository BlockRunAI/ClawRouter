import { describe, expect, it } from "vitest";

import { route } from "./index.js";
import { DEFAULT_ROUTING_CONFIG } from "./config.js";
import type { ModelPricing } from "./selector.js";

const pricing = new Map<string, ModelPricing>([
  ["anthropic/claude-sonnet-4.6", { inputPrice: 3, outputPrice: 15 }],
  ["anthropic/claude-sonnet-5", { inputPrice: 3, outputPrice: 15 }],
  ["anthropic/claude-opus-5", { inputPrice: 5, outputPrice: 25 }],
  ["anthropic/claude-opus-4.8", { inputPrice: 5, outputPrice: 25 }],
  ["openai/gpt-5.3-codex", { inputPrice: 1.75, outputPrice: 14 }],
  ["openai/gpt-5-mini", { inputPrice: 0.25, outputPrice: 2 }],
  ["openai/gpt-4.1", { inputPrice: 2, outputPrice: 8 }],
  ["google/gemini-3.5-flash", { inputPrice: 0.5, outputPrice: 3 }],
  ["google/gemini-3-flash-preview", { inputPrice: 0.5, outputPrice: 3 }],
  ["google/gemini-3.1-pro", { inputPrice: 2, outputPrice: 12 }],
  ["moonshot/kimi-k3", { inputPrice: 3, outputPrice: 15 }],
  ["deepseek/deepseek-v4-pro", { inputPrice: 0.435, outputPrice: 0.87 }],
  ["xai/grok-4.5", { inputPrice: 2, outputPrice: 10 }],
  ["qwen/qwen3.7-max", { inputPrice: 1.475, outputPrice: 4.425 }],
  ["zai/glm-5.2", { inputPrice: 1.4, outputPrice: 4.4 }],
  ["moonshot/kimi-k2.7", { inputPrice: 0.95, outputPrice: 4 }],
  ["moonshot/kimi-k2.6", { inputPrice: 0.95, outputPrice: 4 }],
  ["moonshot/kimi-k2.5", { inputPrice: 0.6, outputPrice: 3 }],
  ["xai/grok-4-1-fast-non-reasoning", { inputPrice: 0.2, outputPrice: 0.5 }],
  ["openai/gpt-4o-mini", { inputPrice: 0.15, outputPrice: 0.6 }],
  ["deepseek/deepseek-chat", { inputPrice: 0.2, outputPrice: 0.4 }],
  ["free/seed-oss-36b", { inputPrice: 0, outputPrice: 0 }],
]);

describe("PortfolioStrategy", () => {
  it("keeps only tool-capable models for a coding agent request", () => {
    const decision = route(
      "Fix the TypeScript payment retry bug, run tests, and update the patch.",
      undefined,
      4096,
      { config: DEFAULT_ROUTING_CONFIG, modelPricing: pricing, hasTools: true },
    );

    expect(decision.method).toBe("portfolio");
    expect(decision.taskType).toBe("code_agent");
    expect(decision.model).toBe("openai/gpt-5-mini");
    expect(decision.candidates).toContain(decision.model);
    expect(decision.candidates).toContain("openai/gpt-5.3-codex");
    expect(["moonshot/kimi-k2.7", "moonshot/kimi-k2.6", "moonshot/kimi-k2.5"]).not.toContain(
      decision.model,
    );
    expect(decision.candidates).not.toContain("google/gemini-3.1-pro");
  });

  it("classifies a non-code function call as a tool agent", () => {
    const decision = route("Use the lookup_order tool for order B-42.", undefined, 256, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing: pricing,
      hasTools: true,
    });

    expect(["tool_agent", "tool_agent_parallel"]).toContain(decision.taskType);
    expect(decision.model).toBe("anthropic/claude-sonnet-5");
    expect(decision.candidates).toContain(decision.model);
    expect(decision.candidates).toContain("google/gemini-3.5-flash");
    expect(["moonshot/kimi-k2.7", "moonshot/kimi-k2.6", "moonshot/kimi-k2.5"]).not.toContain(
      decision.model,
    );
  });

  it.each([
    "请问北京的当前天气状况如何？还有，上海的天气情况是怎样的？",
    "For breakfast I had a 12 ounce iced coffee and a banana.\n\nFor lunch I had a quesadilla.\n\nBreakfast four ounces of asparagus and two eggs.",
    "¿Cuáles son las condiciones del clima en Cancún, Playa del Carmen y Tulum?",
    "Could you tell me the current temperature in Boston, MA and San Francisco, please?",
    "What's the snow like in the two cities of Paris and Bordeaux?",
    "What's cost of 2 and 4 gb ram machine on aws ec2 with one CPU?",
    "能帮我查一下中国广州市和北京市现在的天气状况吗？请使用公制单位。",
    "Could you provide the latest news for Paris, France, and also for Letterkenny, Ireland?",
    "I'd like to change my food order to a salad, and for the drink, update it to coffee.",
  ])(
    "routes a high-confidence repeated single-tool request to the calibrated parallel specialist",
    (prompt) => {
      const decision = route(prompt, undefined, 600, {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 1,
      });

      expect(decision.taskType).toBe("tool_agent_parallel");
      expect(decision.model).toBe("anthropic/claude-opus-4.8");
    },
  );

  it("keeps an ordinary single lookup on the standard tool-agent path", () => {
    const decision = route("Use lookup_order for order B-42.", undefined, 256, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing: pricing,
      routingProfile: "auto",
      hasTools: true,
      requiresTools: true,
      toolCount: 1,
    });

    expect(decision.taskType).toBe("tool_agent");
    expect(decision.model).toBe("anthropic/claude-sonnet-5");
    expect(decision.candidates).toContain("google/gemini-3.5-flash");
  });

  it("keeps deep multi-clue web research on the empirically steadier Sonnet 5", () => {
    const decision = route(
      "Research the following clues across multiple public sources and identify the country.",
      undefined,
      2048,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 2,
        toolNames: ["web_search", "web_fetch"],
      },
    );

    expect(["tool_agent", "tool_agent_parallel"]).toContain(decision.taskType);
    expect(decision.model).toBe("anthropic/claude-sonnet-5");
    expect(decision.reasoning).toContain("deepWebResearch=true");
    expect(decision.candidates?.slice(0, 3)).toEqual([
      "anthropic/claude-sonnet-5",
      "openai/gpt-5-mini",
      "google/gemini-3.5-flash",
    ]);
    expect(decision.reasoning).toContain("candidates=");
  });

  it("keeps a routine web lookup on Sonnet 5", () => {
    const decision = route(
      "Search the official documentation for the current API timeout setting.",
      undefined,
      1024,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 2,
        toolNames: ["web_search", "web_fetch"],
      },
    );

    expect(decision.model).toBe("anthropic/claude-sonnet-5");
    expect(decision.reasoning).toContain("deepWebResearch=false");
  });

  it("keeps a known cross-reservation batch on the cost-controlled airline model", () => {
    const prompt =
      "Hi! I’d like to make some changes to my bookings. I need to cancel two of my upcoming reservations and upgrade another one to business class. Can you help me with that?";
    const decision = route(prompt, undefined, 4096, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing: pricing,
      routingProfile: "auto",
      hasTools: true,
      requiresTools: true,
      toolCount: 7,
      toolNames: [
        "get_user_details",
        "get_reservation_details",
        "search_direct_flight",
        "update_reservation_flights",
        "cancel_reservation",
        "book_reservation",
        "update_reservation_baggages",
      ],
    });

    expect(["tool_agent", "tool_agent_parallel"]).toContain(decision.taskType);
    expect(decision.reasoning).toContain("agentRisk=high");
    expect(decision.model).toBe("openai/gpt-5-mini");
  });

  it("promotes conditional-global airline work to the complex band", () => {
    const decision = route(
      "Cancel all your future reservations that contain flights longer than 4 hours. For flights under 3 hours, upgrade to business wherever possible.",
      undefined,
      4096,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 7,
        toolNames: [
          "get_user_details",
          "get_reservation_details",
          "search_direct_flight",
          "update_reservation_flights",
          "cancel_reservation",
          "book_reservation",
          "update_reservation_baggages",
        ],
      },
    );

    expect(decision.reasoning).toContain("agentRisk=complex_high");
    expect(decision.model).toBe("anthropic/claude-sonnet-5");
  });

  it.each([
    "Create a file called hello.txt in the current directory. Write Hello, world! to it and end with a newline.",
    "Convert the file /app/data.csv into a Parquet file named /app/data.parquet.",
    "Create and run a server on port 3000 with a single GET endpoint /fib that returns JSON.",
    "A script called 'process_data.sh' in the current directory won't run. Figure out what's wrong and fix it so the script can run successfully.",
  ])("uses the calibrated low-cost code agent for deterministic local terminal work", (prompt) => {
    const decision = route(prompt, undefined, 4096, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing: pricing,
      routingProfile: "auto",
      hasTools: true,
      requiresTools: true,
      toolCount: 3,
      toolNames: ["TerminalExec", "TerminalInspect", "TerminalSendKeys"],
    });

    expect(decision.taskType).toBe("code_agent");
    expect(decision.model).toBe("openai/gpt-5-mini");
    expect(decision.reasoning).toContain("terminalCode=true");
  });

  it("promotes a multi-script dependency repair to the strong Terminal Agent band", () => {
    const decision = route(
      "There's a data processing pipeline in the current directory consisting of multiple scripts that need to run in sequence. The main script 'run_pipeline.sh' is failing to execute properly. Identify and fix all issues with the script files and dependencies to make the pipeline run successfully.",
      undefined,
      4096,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 3,
        toolNames: ["TerminalExec", "TerminalInspect", "TerminalSendKeys"],
      },
    );

    expect(decision.taskType).toBe("tool_agent");
    expect(decision.reasoning).toContain("agentRisk=complex_high");
    expect(decision.model).toBe("anthropic/claude-sonnet-5");
    expect(decision.model).not.toBe("openai/gpt-5-mini");
  });

  it("promotes a cross-runtime polyglot artifact to the strong Terminal Agent band", () => {
    const decision = route(
      "Write one /app/main.c.rs polyglot file that must compile and run with both rustc main.c.rs and gcc main.c.rs -o cmain.",
      undefined,
      4096,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 3,
        toolNames: ["TerminalExec", "TerminalInspect", "TerminalSendKeys"],
      },
    );

    expect(decision.taskType).toBe("code_agent");
    expect(decision.reasoning).toContain("agentRisk=complex_high");
    expect(decision.model).toBe("anthropic/claude-sonnet-5");
  });

  it("promotes a framework checkpoint port to a native CLI to the strong Terminal Agent band", () => {
    const decision = route(
      "Implement a command line tool programmed in C that runs inference using a pre-trained PyTorch state_dict called simple_mnist.pth. The final output must be a native cli_tool binary plus weights.json.",
      undefined,
      4096,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 3,
        toolNames: ["TerminalExec", "TerminalInspect", "TerminalSendKeys"],
      },
    );

    expect(decision.taskType).toBe("code_agent");
    expect(decision.reasoning).toContain("agentRisk=complex_high");
    expect(decision.model).toBe("anthropic/claude-sonnet-5");
  });

  it.each([
    "Configure a git server over SSH and deploy two branches through Nginx HTTPS with password authentication.",
    "Securely decommission the service: encrypt the archive with GPG, shred the sensitive files, then delete them.",
    "Evaluate an embedding model with the MTEB benchmark and write the official result file.",
    "Inspect the chess board image and write the best move to a file.",
    "Create a JSON processor from three CSV inputs. Requirements: 1. Follow schema.json. 2. Join departments and employees. 3. Calculate statistics.",
  ])("keeps complex or risky terminal operations on the generic Agent path", (prompt) => {
    const decision = route(prompt, undefined, 4096, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing: pricing,
      routingProfile: "auto",
      hasTools: true,
      requiresTools: true,
      toolCount: 3,
      toolNames: ["TerminalExec", "TerminalInspect", "TerminalSendKeys"],
    });

    expect(decision.taskType).not.toBe("code_agent");
    expect(decision.reasoning).toContain("terminalCode=false");
  });

  it("keeps Codex below the primary band for security-sensitive Terminal file operations", () => {
    const decision = route(
      "Please help me encrypt all the files I have in the data/ folder using rencrypt. Use the most secure encryption and write the outputs to encrypted_data/ with the same basenames.",
      undefined,
      4096,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 3,
        toolNames: ["TerminalExec", "TerminalInspect", "TerminalSendKeys"],
      },
    );

    expect(decision.taskType).toBe("tool_agent");
    expect(decision.reasoning).toContain("terminalSafety=true");
    expect(decision.model).toBe("anthropic/claude-sonnet-5");
    expect(decision.candidates).toContain("openai/gpt-5.3-codex");
    expect((decision.candidateScores ?? []).map((row) => row.model)).not.toContain(
      "openai/gpt-5.3-codex",
    );
  });

  it("admits a cost-controlled strong model for sensitive multi-file Terminal work", () => {
    const decision = route(
      "Sanitize this git repository by replacing all AWS, GitHub, and Hugging Face API keys with consistent placeholders across every affected file. Also, do not make any other unnecessary changes to files without sensitive information.",
      undefined,
      4096,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 3,
        toolNames: ["TerminalExec", "TerminalInspect", "TerminalSendKeys"],
      },
    );

    expect(decision.taskType).toBe("tool_agent_parallel");
    expect(decision.model).toBe("anthropic/claude-sonnet-5");
    expect(decision.candidates).toContain("anthropic/claude-sonnet-5");
  });

  it.each([
    "Reverse engineer the mystery binary, then write and compile image.c so it produces the requested path-traced image.",
    "Create a local JSON server for Solana devnet with status, block, account, transaction, and paginated program-account endpoints.",
    "Create a Solana devnet API whose transaction endpoint returns token transfers with account, mint, and amount fields.",
  ])("cost-controls complex Terminal work that is not safety-sensitive", (prompt) => {
    const decision = route(prompt, undefined, 4096, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing: pricing,
      routingProfile: "auto",
      hasTools: true,
      requiresTools: true,
      toolCount: 3,
      toolNames: ["TerminalExec", "TerminalInspect", "TerminalSendKeys"],
    });

    expect(["tool_agent", "tool_agent_parallel", "code_agent"]).toContain(decision.taskType);
    expect(decision.model).toBe("openai/gpt-5-mini");
    expect(decision.reasoning).toContain("terminalSafety=false");
  });

  it.each([
    "Rotate the expired authentication token and update the bearer token used by the production service.",
    "Replace every leaked API key and password in this repository without changing unrelated files.",
  ])("keeps credential-bearing Terminal work safety-sensitive", (prompt) => {
    const decision = route(prompt, undefined, 4096, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing: pricing,
      routingProfile: "auto",
      hasTools: true,
      requiresTools: true,
      toolCount: 3,
      toolNames: ["TerminalExec", "TerminalInspect", "TerminalSendKeys"],
    });

    expect(decision.reasoning).toContain("terminalSafety=true");
    expect(decision.model).not.toBe("openai/gpt-5-mini");
  });

  it("uses the trajectory-validated high-risk model for retail order tools", () => {
    const decision = route(
      "Exchange both items after I confirm the price difference.",
      undefined,
      512,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 4,
        toolNames: [
          "get_order_details",
          "get_product_details",
          "exchange_delivered_order_items",
          "modify_pending_order_address",
        ],
      },
    );

    expect(["tool_agent", "tool_agent_parallel"]).toContain(decision.taskType);
    expect(decision.model).toBe("deepseek/deepseek-v4-pro");
    expect(decision.candidates).toContain("openai/gpt-5-mini");
  });

  it("uses the calibrated low-cost model for one local retail operation", () => {
    const decision = route(
      "Change the blue earbuds in order W5061109 to red after I confirm.",
      undefined,
      4096,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 6,
        toolNames: [
          "find_user_id_by_name_zip",
          "get_order_details",
          "get_product_details",
          "modify_pending_order_items",
        ],
      },
    );

    expect(decision.taskType).toBe("tool_agent");
    expect(decision.model).toBe("openai/gpt-5-mini");
  });

  it("keeps global retail choices on the high-risk calibrated model", () => {
    const decision = route(
      "Exchange my tablet for the cheapest available variant in another order.",
      undefined,
      4096,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 6,
        toolNames: ["get_order_details", "get_product_details", "exchange_delivered_order_items"],
      },
    );

    expect(decision.model).toBe("deepseek/deepseek-v4-pro");
  });

  it("uses the policy specialist for a refund targeted at another card", () => {
    const decision = route(
      "Return everything except the pet bed and refund it to my Amex card.",
      undefined,
      4096,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 6,
        toolNames: [
          "get_order_details",
          "return_delivered_order_items",
          "transfer_to_human_agents",
        ],
      },
    );

    expect(["tool_agent", "tool_agent_parallel"]).toContain(decision.taskType);
    expect(decision.model).toBe("openai/gpt-4.1");
    expect(decision.reasoning).toContain("agentRisk=policy_exception");
  });

  it("keeps a single comparative send-back request on the current low-cost model", () => {
    const decision = route(
      "Send back the pricier one and get my money back on my credit card.",
      undefined,
      4096,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 6,
        toolNames: [
          "get_order_details",
          "return_delivered_order_items",
          "transfer_to_human_agents",
        ],
      },
    );

    expect(decision.model).toBe("openai/gpt-5-mini");
    expect(decision.reasoning).toContain("agentRisk=policy_exception_simple");
  });

  it("uses the policy specialist when a named-card refund covers multiple returned objects", () => {
    const decision = route(
      "Return these two skateboards and refund them to my credit card.",
      undefined,
      4096,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 6,
        toolNames: [
          "get_order_details",
          "return_delivered_order_items",
          "transfer_to_human_agents",
        ],
      },
    );

    expect(decision.model).toBe("openai/gpt-4.1");
    expect(decision.reasoning).toContain("agentRisk=policy_exception");
  });

  it("treats a simple-looking retail return as a negotiated high-risk workflow", () => {
    const decision = route(
      "I want to return an office chair that arrived broken.",
      undefined,
      4096,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 6,
        toolNames: [
          "get_order_details",
          "get_product_details",
          "return_delivered_order_items",
          "exchange_delivered_order_items",
        ],
      },
    );

    expect(decision.taskType).toBe("tool_agent");
    expect(decision.model).toBe("deepseek/deepseek-v4-pro");
    expect(decision.reasoning).toContain("agentRisk=high");
  });

  it("uses the cost-efficient trajectory-validated model for airline tools", () => {
    const decision = route("Change my flight after checking the reservation.", undefined, 512, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing: pricing,
      routingProfile: "auto",
      hasTools: true,
      requiresTools: true,
      toolCount: 3,
      toolNames: ["get_reservation_details", "search_direct_flight", "update_reservation_flights"],
    });

    expect(["tool_agent", "tool_agent_parallel"]).toContain(decision.taskType);
    expect(decision.model).toBe("openai/gpt-5-mini");
    expect(decision.candidates).toContain("anthropic/claude-sonnet-5");
  });

  it("does not mistake airline cabin class for a code-agent task", () => {
    const decision = route(
      "Move my flight to May 24 and upgrade all passengers to business class.",
      undefined,
      4096,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 8,
        toolNames: [
          "get_reservation_details",
          "search_direct_flight",
          "update_reservation_flights",
        ],
      },
    );

    expect(decision.taskType).not.toBe("code_agent");
    expect(decision.model).toBe("openai/gpt-5-mini");
    expect(decision.reasoning).toContain("agentRisk=high");
  });

  it("reserves the airline specialist for global itinerary optimization", () => {
    const decision = route(
      "Show my gift card and certificate balances, then change my reservation to the cheapest business round trip without changing the dates.",
      undefined,
      4096,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 8,
        toolNames: [
          "get_user_details",
          "get_reservation_details",
          "search_onestop_flight",
          "cancel_reservation",
          "book_reservation",
        ],
      },
    );

    expect(decision.taskType).not.toBe("code_agent");
    expect(decision.model).toBe("anthropic/claude-sonnet-5");
    expect(decision.reasoning).toContain("agentRisk=complex_high");
  });

  it("does not mistake a lookup followed by local explanation for parallel tool use", () => {
    const decision = route(
      "Get the weather for London and explain whether I need an umbrella.",
      undefined,
      256,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 1,
        toolNames: ["get_current_weather"],
      },
    );

    expect(decision.taskType).toBe("tool_agent");
  });

  it("uses two distinctive visible tool names as a multi-operation signal", () => {
    const decision = route(
      "Add task draft release notes, then delete task obsolete draft.",
      undefined,
      256,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 2,
        toolNames: ["add_task", "delete_task"],
      },
    );

    expect(decision.taskType).toBe("tool_agent_parallel");
  });

  it("does not spend-upgrade a large numbered multi-tool plan without supporting quality evidence", () => {
    const decision = route(
      "Do all the following:\n1. Clone the repository.\n2. Analyze it.\n3. Create Docker and Kubernetes files.\n4. Commit and push.",
      undefined,
      600,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 7,
        toolNames: [
          "clone_repo",
          "analyze_repo",
          "create_docker_file",
          "create_kubernetes_yaml",
          "commit_changes",
          "push_changes",
          "read_file",
        ],
      },
    );

    expect(decision.taskType).not.toBe("tool_agent_parallel");
    expect(decision.model).not.toBe("anthropic/claude-opus-4.8");
  });

  it("detects an explicit multi-object request even when a distractor tool is visible", () => {
    const decision = route(
      "What's the weather like in the two cities of Boston and San Francisco?",
      undefined,
      600,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        routingProfile: "auto",
        hasTools: true,
        requiresTools: true,
        toolCount: 2,
      },
    );

    expect(decision.taskType).toBe("tool_agent_parallel");
    expect(decision.model).toBe("anthropic/claude-opus-4.8");
  });

  it("does not classify ordinary QA as a tool task just because the host exposes tools", () => {
    const decision = route(
      "Which answer is correct?\nA. One\nB. Two\nC. Three\nD. Four",
      undefined,
      256,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
        hasTools: true,
        requiresTools: false,
      },
    );

    expect(decision.taskType).toBe("reasoning_mcq");
    expect(decision.profile).toBe("auto");
    expect(decision.model).toBe("google/gemini-3-flash-preview");
  });

  it("adds current long-context models instead of relying on a legacy tier chain", () => {
    const decision = route("A".repeat(340_000), undefined, 1_024, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing: pricing,
    });

    expect(decision.taskType).toBe("long_context");
    expect((decision.candidateScores ?? []).map((row) => row.model)).not.toContain(
      "deepseek/deepseek-v4-pro",
    );
    expect(decision.candidates).toContain("deepseek/deepseek-v4-pro");
    expect(decision.model).toBe("google/gemini-3.1-pro");
    expect(decision.candidates).toContain(decision.model);
  });

  it("keeps Mandarin structured extraction in the source-language affinity band", () => {
    const decision = route(
      "只输出 JSON：从订单 A-17，数量 3，状态已发货中提取 orderId、quantity、status 三个字段。",
      undefined,
      256,
      {
        config: DEFAULT_ROUTING_CONFIG,
        modelPricing: pricing,
      },
    );

    expect(decision.taskType).toBe("extraction");
    expect(decision.model).toBe("moonshot/kimi-k2.7");
    expect(decision.candidates?.[0]).toBe("moonshot/kimi-k2.7");
  });

  it("does not promote a generic recovery fallback without task affinity", () => {
    const decision = route("Patch this API secret validation error.", undefined, 256, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing: pricing,
    });

    // DeepSeek Chat is a valid availability fallback in the SIMPLE tier, but
    // is not an explicitly profiled code-edit specialist. It must not win the
    // Auto ranking simply because it is inexpensive.
    expect((decision.candidateScores ?? []).map((row) => row.model)).not.toContain(
      "deepseek/deepseek-chat",
    );
    expect(decision.candidates).toContain("deepseek/deepseek-chat");
  });

  it("does not let a flash-lite sibling inherit flash task affinity", () => {
    const exactNameConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      tiers: Object.fromEntries(
        Object.keys(DEFAULT_ROUTING_CONFIG.tiers).map((tier) => [
          tier,
          {
            primary: "google/gemini-2.5-flash",
            fallback: ["google/gemini-2.5-flash-lite"],
          },
        ]),
      ) as typeof DEFAULT_ROUTING_CONFIG.tiers,
    };
    const decision = route("Explain the deployment status.", undefined, 256, {
      config: exactNameConfig,
      modelPricing: new Map([
        ["google/gemini-2.5-flash", { inputPrice: 1, outputPrice: 1 }],
        ["google/gemini-2.5-flash-lite", { inputPrice: 0.1, outputPrice: 0.1 }],
      ]),
    });

    expect(decision.candidates?.[0]).toBe("google/gemini-2.5-flash");
    expect(decision.candidates).toContain("google/gemini-2.5-flash-lite");
    expect((decision.candidateScores ?? []).map((row) => row.model)).not.toContain(
      "google/gemini-2.5-flash-lite",
    );
  });

  it("filters models that cannot satisfy the requested output length", () => {
    const decision = route("Explain this architecture", undefined, 20_000, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing: pricing,
    });

    expect(decision.candidates).not.toContain("xai/grok-4-fast-non-reasoning");
  });

  it("only lets fresh performance observations influence the candidate order", () => {
    const equalCostPricing = new Map<string, ModelPricing>([
      ["xai/grok-4-1-fast-non-reasoning", { inputPrice: 1, outputPrice: 1 }],
      ["openai/gpt-4o-mini", { inputPrice: 1, outputPrice: 1 }],
    ]);
    const twoCandidateConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      tiers: Object.fromEntries(
        Object.keys(DEFAULT_ROUTING_CONFIG.tiers).map((tier) => [
          tier,
          {
            primary: "xai/grok-4-1-fast-non-reasoning",
            fallback: ["openai/gpt-4o-mini"],
          },
        ]),
      ) as typeof DEFAULT_ROUTING_CONFIG.tiers,
    };
    const decision = route("Extract the fields as JSON", undefined, 512, {
      config: twoCandidateConfig,
      modelPricing: equalCostPricing,
      now: new Date("2026-07-21T00:00:00Z"),
      modelPerformance: {
        "openai/gpt-4o-mini": {
          measuredAt: "2026-07-21T00:00:00Z",
          latencyMs: 600,
          outputTokensPerSecond: 250,
          intelligenceIndex: 50,
        },
      },
    });

    expect(decision.taskType).toBe("extraction");
    expect(decision.candidates?.[0]).toBe("openai/gpt-4o-mini");
  });

  it("treats a small performance probe as a tie-breaker, not a tier override", () => {
    const equalCostPricing = new Map<string, ModelPricing>([
      ["xai/grok-4-1-fast-non-reasoning", { inputPrice: 1, outputPrice: 1 }],
      ["openai/gpt-4o-mini", { inputPrice: 1, outputPrice: 1 }],
    ]);
    const twoCandidateConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      tiers: Object.fromEntries(
        Object.keys(DEFAULT_ROUTING_CONFIG.tiers).map((tier) => [
          tier,
          {
            primary: "xai/grok-4-1-fast-non-reasoning",
            fallback: ["openai/gpt-4o-mini"],
          },
        ]),
      ) as typeof DEFAULT_ROUTING_CONFIG.tiers,
    };
    const decision = route("Explain the deployment status.", undefined, 512, {
      config: twoCandidateConfig,
      modelPricing: equalCostPricing,
      now: new Date("2026-07-21T00:00:00Z"),
      modelPerformance: {
        "openai/gpt-4o-mini": {
          measuredAt: "2026-07-21T00:00:00Z",
          latencyMs: 600,
          outputTokensPerSecond: 250,
          intelligenceIndex: 50,
          samples: 1,
        },
      },
    });

    expect(decision.candidates?.[0]).toBe("xai/grok-4-1-fast-non-reasoning");
  });
});
