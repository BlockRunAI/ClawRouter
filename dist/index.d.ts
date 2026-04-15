/**
 * OpenClaw Plugin Types (locally defined)
 *
 * OpenClaw's plugin SDK uses duck typing — these match the shapes
 * expected by registerProvider() and the plugin system.
 * Defined locally to avoid depending on internal OpenClaw paths.
 */
type ModelApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai" | "github-copilot" | "bedrock-converse-stream";
type ModelDefinitionConfig = {
    id: string;
    name: string;
    api?: ModelApi;
    reasoning: boolean;
    input: Array<"text" | "image">;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
    headers?: Record<string, string>;
};
type ModelProviderConfig = {
    baseUrl: string;
    apiKey?: string;
    api?: ModelApi;
    headers?: Record<string, string>;
    authHeader?: boolean;
    models: ModelDefinitionConfig[];
};
type AuthProfileCredential = {
    apiKey?: string;
    type?: string;
    [key: string]: unknown;
};
type ProviderAuthResult = {
    profiles: Array<{
        profileId: string;
        credential: AuthProfileCredential;
    }>;
    configPatch?: Record<string, unknown>;
    defaultModel?: string;
    notes?: string[];
};
type WizardPrompter = {
    text: (opts: {
        message: string;
        validate?: (value: string) => string | undefined;
    }) => Promise<string | symbol>;
    note: (message: string) => void;
    progress: (message: string) => {
        stop: (message?: string) => void;
    };
};
type ProviderAuthContext = {
    config: Record<string, unknown>;
    agentDir?: string;
    workspaceDir?: string;
    prompter: WizardPrompter;
    runtime: {
        log: (message: string) => void;
    };
    isRemote: boolean;
    openUrl: (url: string) => Promise<void>;
};
type ProviderAuthMethod = {
    id: string;
    label: string;
    hint?: string;
    kind: "oauth" | "api_key" | "token" | "device_code" | "custom";
    run: (ctx: ProviderAuthContext) => Promise<ProviderAuthResult>;
};
type ProviderPlugin = {
    id: string;
    label: string;
    docsPath?: string;
    aliases?: string[];
    envVars?: string[];
    models?: ModelProviderConfig;
    auth: ProviderAuthMethod[];
    formatApiKey?: (cred: AuthProfileCredential) => string;
};
type PluginLogger = {
    debug?: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
};
type OpenClawPluginService = {
    id: string;
    start: () => void | Promise<void>;
    stop?: () => void | Promise<void>;
};
type ImageGenerationResolution = "1K" | "2K" | "4K";
type GeneratedImageAsset = {
    buffer: Buffer;
    mimeType: string;
    fileName?: string;
    revisedPrompt?: string;
    metadata?: Record<string, unknown>;
};
type ImageGenerationSourceImage = {
    buffer: Buffer;
    mimeType: string;
    fileName?: string;
    metadata?: Record<string, unknown>;
};
type ImageGenerationRequest = {
    provider: string;
    model: string;
    prompt: string;
    cfg: Record<string, unknown>;
    agentDir?: string;
    timeoutMs?: number;
    count?: number;
    size?: string;
    aspectRatio?: string;
    resolution?: ImageGenerationResolution;
    inputImages?: ImageGenerationSourceImage[];
};
type ImageGenerationResult = {
    images: GeneratedImageAsset[];
    model?: string;
    metadata?: Record<string, unknown>;
};
type ImageGenerationProviderCapabilities = {
    generate: {
        maxCount?: number;
        supportsSize?: boolean;
        supportsAspectRatio?: boolean;
        supportsResolution?: boolean;
    };
    edit: {
        enabled: boolean;
        maxInputImages?: number;
        maxCount?: number;
        supportsSize?: boolean;
    };
    geometry?: {
        sizes?: string[];
        resolutions?: ImageGenerationResolution[];
    };
};
type ImageGenerationProviderPlugin = {
    id: string;
    aliases?: string[];
    label?: string;
    defaultModel?: string;
    models?: string[];
    capabilities: ImageGenerationProviderCapabilities;
    isConfigured?: (ctx: {
        cfg?: Record<string, unknown>;
    }) => boolean;
    generateImage: (req: ImageGenerationRequest) => Promise<ImageGenerationResult>;
};
type MusicGenerationOutputFormat = "mp3" | "wav";
type GeneratedMusicAsset = {
    buffer: Buffer;
    mimeType: string;
    fileName?: string;
    metadata?: Record<string, unknown>;
};
type MusicGenerationRequest = {
    provider: string;
    model: string;
    prompt: string;
    cfg: Record<string, unknown>;
    agentDir?: string;
    timeoutMs?: number;
    lyrics?: string;
    instrumental?: boolean;
    durationSeconds?: number;
    format?: MusicGenerationOutputFormat;
};
type MusicGenerationResult = {
    tracks: GeneratedMusicAsset[];
    model?: string;
    lyrics?: string[];
    metadata?: Record<string, unknown>;
};
type MusicGenerationProviderCapabilities = {
    maxTracks?: number;
    maxDurationSeconds?: number;
    supportsLyrics?: boolean;
    supportsInstrumental?: boolean;
    supportsDuration?: boolean;
    supportsFormat?: boolean;
    supportedFormats?: readonly MusicGenerationOutputFormat[];
};
type MusicGenerationProviderPlugin = {
    id: string;
    aliases?: string[];
    label?: string;
    defaultModel?: string;
    models?: string[];
    capabilities: MusicGenerationProviderCapabilities;
    isConfigured?: (ctx: {
        cfg?: Record<string, unknown>;
    }) => boolean;
    generateMusic: (req: MusicGenerationRequest) => Promise<MusicGenerationResult>;
};
type OpenClawPluginApi = {
    id: string;
    name: string;
    version?: string;
    description?: string;
    source: string;
    config: Record<string, unknown> & {
        models?: {
            providers?: Record<string, ModelProviderConfig>;
        };
        agents?: Record<string, unknown>;
    };
    pluginConfig?: Record<string, unknown>;
    logger: PluginLogger;
    registerProvider: (provider: ProviderPlugin) => void;
    registerImageGenerationProvider: (provider: ImageGenerationProviderPlugin) => void;
    registerMusicGenerationProvider: (provider: MusicGenerationProviderPlugin) => void;
    registerVideoGenerationProvider?: (provider: unknown) => void;
    registerTool: (tool: unknown, opts?: unknown) => void;
    registerHook: (events: string | string[], handler: unknown, opts?: unknown) => void;
    registerHttpRoute: (params: {
        path: string;
        handler: unknown;
    }) => void;
    registerService: (service: OpenClawPluginService) => void;
    registerCommand: (command: unknown) => void;
    resolvePath: (input: string) => string;
    on: (hookName: string, handler: unknown, opts?: unknown) => void;
};
type OpenClawPluginDefinition = {
    id?: string;
    name?: string;
    description?: string;
    version?: string;
    register?: (api: OpenClawPluginApi) => void | Promise<void>;
    activate?: (api: OpenClawPluginApi) => void | Promise<void>;
    deactivate?: (api: OpenClawPluginApi) => void | Promise<void>;
};

/**
 * Tier → Model Selection
 *
 * Maps a classification tier to the cheapest capable model.
 * Builds RoutingDecision metadata with cost estimates and savings.
 */

type ModelPricing = {
    inputPrice: number;
    outputPrice: number;
    /** Active promo flat price per request (overrides token-based pricing when set) */
    flatPrice?: number;
};
/**
 * Get the ordered fallback chain for a tier: [primary, ...fallbacks].
 */
declare function getFallbackChain(tier: Tier, tierConfigs: Record<Tier, TierConfig>): string[];
declare function calculateModelCost(model: string, modelPricing: Map<string, ModelPricing>, estimatedInputTokens: number, maxOutputTokens: number, routingProfile?: "free" | "eco" | "auto" | "premium"): {
    costEstimate: number;
    baselineCost: number;
    savings: number;
};
/**
 * Get the fallback chain filtered by context length.
 * Only returns models that can handle the estimated total context.
 *
 * @param tier - The tier to get fallback chain for
 * @param tierConfigs - Tier configurations
 * @param estimatedTotalTokens - Estimated total context (input + output)
 * @param getContextWindow - Function to get context window for a model ID
 * @returns Filtered list of models that can handle the context
 */
declare function getFallbackChainFiltered(tier: Tier, tierConfigs: Record<Tier, TierConfig>, estimatedTotalTokens: number, getContextWindow: (modelId: string) => number | undefined): string[];

/**
 * Smart Router Types
 *
 * Four classification tiers — REASONING is distinct from COMPLEX because
 * reasoning tasks need different models (o3, gemini-pro) than general
 * complex tasks (gpt-4o, sonnet-4).
 *
 * Scoring uses weighted float dimensions with sigmoid confidence calibration.
 */
type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";
type RoutingDecision = {
    model: string;
    tier: Tier;
    confidence: number;
    method: "rules" | "llm";
    reasoning: string;
    costEstimate: number;
    baselineCost: number;
    savings: number;
    agenticScore?: number;
    /** Which tier configs were used (auto/eco/premium/agentic) — avoids re-derivation in proxy */
    tierConfigs?: Record<Tier, TierConfig>;
    /** Which routing profile was applied */
    profile?: "auto" | "eco" | "premium" | "agentic";
};
type RouterOptions = {
    config: RoutingConfig;
    modelPricing: Map<string, ModelPricing>;
    routingProfile?: "eco" | "auto" | "premium";
    hasTools?: boolean;
    /** Override current time for promotion window checks (for testing). Default: new Date() */
    now?: Date;
};
type TierConfig = {
    primary: string;
    fallback: string[];
};
type ScoringConfig = {
    tokenCountThresholds: {
        simple: number;
        complex: number;
    };
    codeKeywords: string[];
    reasoningKeywords: string[];
    simpleKeywords: string[];
    technicalKeywords: string[];
    creativeKeywords: string[];
    imperativeVerbs: string[];
    constraintIndicators: string[];
    outputFormatKeywords: string[];
    referenceKeywords: string[];
    negationKeywords: string[];
    domainSpecificKeywords: string[];
    agenticTaskKeywords: string[];
    dimensionWeights: Record<string, number>;
    tierBoundaries: {
        simpleMedium: number;
        mediumComplex: number;
        complexReasoning: number;
    };
    confidenceSteepness: number;
    confidenceThreshold: number;
};
type ClassifierConfig = {
    llmModel: string;
    llmMaxTokens: number;
    llmTemperature: number;
    promptTruncationChars: number;
    cacheTtlMs: number;
};
type OverridesConfig = {
    maxTokensForceComplex: number;
    structuredOutputMinTier: Tier;
    ambiguousDefaultTier: Tier;
    /**
     * When enabled, prefer models optimized for agentic workflows.
     * Agentic models continue autonomously with multi-step tasks
     * instead of stopping and waiting for user input.
     */
    agenticMode?: boolean;
};
/**
 * Time-windowed promotion that temporarily overrides tier routing.
 * Active promotions are auto-applied; expired ones are ignored at runtime.
 */
type Promotion = {
    /** Human-readable label (e.g. "GLM-5 Launch Promo") */
    name: string;
    /** ISO date string, promotion starts (inclusive). e.g. "2026-04-01" */
    startDate: string;
    /** ISO date string, promotion ends (exclusive). e.g. "2026-04-15" */
    endDate: string;
    /** Partial tier overrides — merged into the active tier configs (primary/fallback) */
    tierOverrides: Partial<Record<Tier, Partial<TierConfig>>>;
    /** Which profiles this applies to. Default: all profiles. */
    profiles?: Array<"auto" | "eco" | "premium" | "agentic">;
};
type RoutingConfig = {
    version: string;
    classifier: ClassifierConfig;
    scoring: ScoringConfig;
    tiers: Record<Tier, TierConfig>;
    /** Tier configs for agentic mode - models that excel at multi-step tasks */
    agenticTiers?: Record<Tier, TierConfig>;
    /** Tier configs for eco profile - ultra cost-optimized (blockrun/eco) */
    ecoTiers?: Record<Tier, TierConfig>;
    /** Tier configs for premium profile - best quality (blockrun/premium) */
    premiumTiers?: Record<Tier, TierConfig>;
    /** Time-windowed promotions that temporarily override tier routing */
    promotions?: Promotion[];
    overrides: OverridesConfig;
};

/**
 * Default Routing Config
 *
 * All routing parameters as a TypeScript constant.
 * Operators override via openclaw.yaml plugin config.
 *
 * Scoring uses 14 weighted dimensions with sigmoid confidence calibration.
 */

declare const DEFAULT_ROUTING_CONFIG: RoutingConfig;

/**
 * Smart Router Entry Point
 *
 * Classifies requests and routes to the cheapest capable model.
 * Delegates to pluggable RouterStrategy (default: RulesStrategy, <1ms).
 */

/**
 * Route a request to the cheapest capable model.
 * Delegates to the registered "rules" strategy by default.
 */
declare function route(prompt: string, systemPrompt: string | undefined, maxOutputTokens: number, options: RouterOptions): RoutingDecision;

/**
 * Response Cache for LLM Completions
 *
 * Caches LLM responses by request hash (model + messages + params).
 * Inspired by LiteLLM's caching system. Returns cached responses for
 * identical requests, saving both cost and latency.
 *
 * Features:
 * - TTL-based expiration (default 10 minutes)
 * - LRU eviction when cache is full
 * - Size limits per item (1MB max)
 * - Heap-based expiration tracking for efficient pruning
 */
type CachedLLMResponse = {
    body: Buffer;
    status: number;
    headers: Record<string, string>;
    model: string;
    cachedAt: number;
    expiresAt: number;
};
type ResponseCacheConfig = {
    /** Maximum number of cached responses. Default: 200 */
    maxSize?: number;
    /** Default TTL in seconds. Default: 600 (10 minutes) */
    defaultTTL?: number;
    /** Maximum size per cached item in bytes. Default: 1MB */
    maxItemSize?: number;
    /** Enable/disable cache. Default: true */
    enabled?: boolean;
};
declare class ResponseCache {
    private cache;
    private expirationHeap;
    private config;
    private stats;
    constructor(config?: ResponseCacheConfig);
    /**
     * Generate cache key from request body.
     * Hashes: model + messages + temperature + max_tokens + other params
     */
    static generateKey(body: Buffer | string): string;
    /**
     * Check if caching is enabled for this request.
     * Respects cache control headers and request params.
     */
    shouldCache(body: Buffer | string, headers?: Record<string, string>): boolean;
    /**
     * Get cached response if available and not expired.
     */
    get(key: string): CachedLLMResponse | undefined;
    /**
     * Cache a response with optional custom TTL.
     */
    set(key: string, response: {
        body: Buffer;
        status: number;
        headers: Record<string, string>;
        model: string;
    }, ttlSeconds?: number): void;
    /**
     * Evict expired and oldest entries to make room.
     */
    private evict;
    /**
     * Get cache statistics.
     */
    getStats(): {
        size: number;
        maxSize: number;
        hits: number;
        misses: number;
        evictions: number;
        hitRate: string;
    };
    /**
     * Clear all cached entries.
     */
    clear(): void;
    /**
     * Check if cache is enabled.
     */
    isEnabled(): boolean;
}

/**
 * Balance Monitor for ClawRouter
 *
 * Monitors USDC balance on Base network with intelligent caching.
 * Provides pre-request balance checks to prevent failed payments.
 *
 * Caching Strategy:
 *   - TTL: 30 seconds (balance is cached to avoid excessive RPC calls)
 *   - Optimistic deduction: after successful payment, subtract estimated cost from cache
 *   - Invalidation: on payment failure, immediately refresh from RPC
 */
/** Balance thresholds in USDC smallest unit (6 decimals) */
declare const BALANCE_THRESHOLDS: {
    /** Low balance warning threshold: $1.00 */
    readonly LOW_BALANCE_MICROS: 1000000n;
    /** Effectively zero threshold: $0.0001 (covers dust/rounding) */
    readonly ZERO_THRESHOLD: 100n;
};
/** Balance information returned by checkBalance() */
type BalanceInfo = {
    /** Raw balance in USDC smallest unit (6 decimals) */
    balance: bigint;
    /** Formatted balance as "$X.XX" */
    balanceUSD: string;
    /** True if balance < $1.00 */
    isLow: boolean;
    /** True if balance < $0.0001 (effectively zero) */
    isEmpty: boolean;
    /** Wallet address for funding instructions */
    walletAddress: string;
};
/** Result from checkSufficient() */
type SufficiencyResult = {
    /** True if balance >= estimated cost */
    sufficient: boolean;
    /** Current balance info */
    info: BalanceInfo;
    /** If insufficient, the shortfall as "$X.XX" */
    shortfall?: string;
};
/**
 * Monitors USDC balance on Base network.
 *
 * Usage:
 *   const monitor = new BalanceMonitor("0x...");
 *   const info = await monitor.checkBalance();
 *   if (info.isLow) console.warn("Low balance!");
 */
declare class BalanceMonitor {
    private readonly client;
    private readonly walletAddress;
    /** Cached balance (null = not yet fetched) */
    private cachedBalance;
    /** Timestamp when cache was last updated */
    private cachedAt;
    constructor(walletAddress: string);
    /**
     * Check current USDC balance.
     * Uses cache if valid, otherwise fetches from RPC.
     */
    checkBalance(): Promise<BalanceInfo>;
    /**
     * Check if balance is sufficient for an estimated cost.
     *
     * @param estimatedCostMicros - Estimated cost in USDC smallest unit (6 decimals)
     */
    checkSufficient(estimatedCostMicros: bigint): Promise<SufficiencyResult>;
    /**
     * Optimistically deduct estimated cost from cached balance.
     * Call this after a successful payment to keep cache accurate.
     *
     * @param amountMicros - Amount to deduct in USDC smallest unit
     */
    deductEstimated(amountMicros: bigint): void;
    /**
     * Invalidate cache, forcing next checkBalance() to fetch from RPC.
     * Call this after a payment failure to get accurate balance.
     */
    invalidate(): void;
    /**
     * Force refresh balance from RPC (ignores cache).
     */
    refresh(): Promise<BalanceInfo>;
    /**
     * Format USDC amount (in micros) as "$X.XX".
     */
    formatUSDC(amountMicros: bigint): string;
    /**
     * Get the wallet address being monitored.
     */
    getWalletAddress(): string;
    /** Fetch balance from RPC */
    private fetchBalance;
    /** Build BalanceInfo from raw balance */
    private buildInfo;
}

/**
 * Solana USDC Balance Monitor
 *
 * Checks USDC balance on Solana mainnet with caching.
 * Absorbed from @blockrun/clawwallet's solana-adapter.ts (balance portion only).
 */
type SolanaBalanceInfo = {
    balance: bigint;
    balanceUSD: string;
    isLow: boolean;
    isEmpty: boolean;
    walletAddress: string;
};
/** Result from checkSufficient() */
type SolanaSufficiencyResult = {
    sufficient: boolean;
    info: SolanaBalanceInfo;
    shortfall?: string;
};
declare class SolanaBalanceMonitor {
    private readonly rpc;
    private readonly walletAddress;
    private cachedBalance;
    private cachedAt;
    constructor(walletAddress: string, rpcUrl?: string);
    checkBalance(): Promise<SolanaBalanceInfo>;
    deductEstimated(amountMicros: bigint): void;
    invalidate(): void;
    refresh(): Promise<SolanaBalanceInfo>;
    /**
     * Check if balance is sufficient for an estimated cost.
     */
    checkSufficient(estimatedCostMicros: bigint): Promise<SolanaSufficiencyResult>;
    /**
     * Format USDC amount (in micros) as "$X.XX".
     */
    formatUSDC(amountMicros: bigint): string;
    getWalletAddress(): string;
    /**
     * Check native SOL balance (in lamports). Useful for detecting users who
     * funded with SOL instead of USDC.
     */
    checkSolBalance(): Promise<bigint>;
    private fetchBalance;
    private fetchBalanceOnce;
    private buildInfo;
}

/**
 * Session Persistence Store
 *
 * Tracks model selections per session to prevent model switching mid-task.
 * When a session is active, the router will continue using the same model
 * instead of re-routing each request.
 */
type SessionEntry = {
    model: string;
    tier: string;
    createdAt: number;
    lastUsedAt: number;
    requestCount: number;
    recentHashes: string[];
    strikes: number;
    escalated: boolean;
    sessionCostMicros: bigint;
};
type SessionConfig = {
    /** Enable session persistence (default: false) */
    enabled: boolean;
    /** Session timeout in ms (default: 30 minutes) */
    timeoutMs: number;
    /** Header name for session ID (default: X-Session-ID) */
    headerName: string;
};
declare const DEFAULT_SESSION_CONFIG: SessionConfig;
/**
 * Session persistence store for maintaining model selections.
 */
declare class SessionStore {
    private sessions;
    private config;
    private cleanupInterval;
    constructor(config?: Partial<SessionConfig>);
    /**
     * Get the pinned model for a session, if any.
     */
    getSession(sessionId: string): SessionEntry | undefined;
    /**
     * Pin a model to a session.
     */
    setSession(sessionId: string, model: string, tier: string): void;
    /**
     * Touch a session to extend its timeout.
     */
    touchSession(sessionId: string): void;
    /**
     * Clear a specific session.
     */
    clearSession(sessionId: string): void;
    /**
     * Clear all sessions.
     */
    clearAll(): void;
    /**
     * Get session stats for debugging.
     */
    getStats(): {
        count: number;
        sessions: Array<{
            id: string;
            model: string;
            age: number;
        }>;
    };
    /**
     * Clean up expired sessions.
     */
    private cleanup;
    /**
     * Record a request content hash and detect repetitive patterns.
     * Returns true if escalation should be triggered (3+ consecutive similar requests).
     */
    recordRequestHash(sessionId: string, hash: string): boolean;
    /**
     * Escalate session to next tier. Returns the new model/tier or null if already at max.
     */
    escalateSession(sessionId: string, tierConfigs: Record<string, {
        primary: string;
        fallback: string[];
    }>): {
        model: string;
        tier: string;
    } | null;
    /**
     * Add cost to a session's running total for maxCostPerRun tracking.
     * Cost is in USDC 6-decimal units (micros).
     * Creates a cost-tracking-only entry if none exists (e.g., explicit model requests
     * that never go through the routing path).
     */
    addSessionCost(sessionId: string, additionalMicros: bigint): void;
    /**
     * Get the total accumulated cost for a session in USD.
     */
    getSessionCostUsd(sessionId: string): number;
    /**
     * Stop the cleanup interval.
     */
    close(): void;
}
/**
 * Generate a session ID from request headers or create a default.
 */
declare function getSessionId(headers: Record<string, string | string[] | undefined>, headerName?: string): string | undefined;
/**
 * Generate a short hash fingerprint from request content.
 * Captures: last user message text + tool call names (if any).
 * Normalizes whitespace to avoid false negatives from minor formatting diffs.
 */
declare function hashRequestContent(lastUserContent: string, toolCallNames?: string[]): string;

/**
 * Local x402 Proxy Server
 *
 * Sits between OpenClaw's pi-ai (which makes standard OpenAI-format requests)
 * and BlockRun's API (which requires x402 micropayments).
 *
 * Flow:
 *   pi-ai → http://localhost:{port}/v1/chat/completions
 *        → proxy forwards to https://blockrun.ai/api/v1/chat/completions
 *        → gets 402 → @x402/fetch signs payment → retries
 *        → streams response back to pi-ai
 *
 * Optimizations (v0.3.0):
 *   - SSE heartbeat: for streaming requests, sends headers + heartbeat immediately
 *     before the x402 flow, preventing OpenClaw's 10-15s timeout from firing.
 *   - Response dedup: hashes request bodies and caches responses for 30s,
 *     preventing double-charging when OpenClaw retries after timeout.
 *   - Smart routing: when model is "blockrun/auto", classify query and pick cheapest model.
 *   - Usage logging: log every request as JSON line to ~/.openclaw/blockrun/logs/
 */

/** Union type for chain-agnostic balance monitoring */
type AnyBalanceMonitor = BalanceMonitor | SolanaBalanceMonitor;

/**
 * Get the proxy port from pre-loaded configuration.
 * Port is validated at module load time, this just returns the cached value.
 */
declare function getProxyPort(): number;
/** Callback info for low balance warning */
type LowBalanceInfo = {
    balanceUSD: string;
    walletAddress: string;
};
/** Callback info for insufficient funds error */
type InsufficientFundsInfo = {
    balanceUSD: string;
    requiredUSD: string;
    walletAddress: string;
};
/**
 * Wallet config: either a plain EVM private key string, or the full
 * resolution object from resolveOrGenerateWalletKey() which may include
 * Solana keys. Using the full object prevents callers from accidentally
 * forgetting to forward Solana key bytes.
 */
type WalletConfig = string | {
    key: string;
    solanaPrivateKeyBytes?: Uint8Array;
};
type PaymentChain = "base" | "solana";
type ProxyOptions = {
    wallet: WalletConfig;
    apiBase?: string;
    /** Payment chain: "base" (default) or "solana". Can also be set via CLAWROUTER_PAYMENT_CHAIN env var. */
    paymentChain?: PaymentChain;
    /** Port to listen on (default: 8402) */
    port?: number;
    routingConfig?: Partial<RoutingConfig>;
    /** Request timeout in ms (default: 180000 = 3 minutes). Covers on-chain tx + LLM response. */
    requestTimeoutMs?: number;
    /** Skip balance checks (for testing only). Default: false */
    skipBalanceCheck?: boolean;
    /** Override the balance monitor with a mock (for testing only). */
    _balanceMonitorOverride?: AnyBalanceMonitor;
    /**
     * Session persistence config. When enabled, maintains model selection
     * across requests within a session to prevent mid-task model switching.
     */
    sessionConfig?: Partial<SessionConfig>;
    /**
     * Auto-compress large requests to reduce network usage.
     * When enabled, requests are automatically compressed using
     * LLM-safe context compression (15-40% reduction).
     * Default: true
     */
    autoCompressRequests?: boolean;
    /**
     * Threshold in KB to trigger auto-compression (default: 180).
     * Requests larger than this are compressed before sending.
     * Set to 0 to compress all requests.
     */
    compressionThresholdKB?: number;
    /**
     * Response caching config. When enabled, identical requests return
     * cached responses instead of making new API calls.
     * Default: enabled with 10 minute TTL, 200 max entries.
     */
    cacheConfig?: ResponseCacheConfig;
    /**
     * Maximum total spend (in USD) per session run.
     * Default: undefined (no limit). Example: 0.5 = $0.50 per session.
     */
    maxCostPerRunUsd?: number;
    /**
     * How to enforce the per-run cost cap.
     * - 'graceful' (default): when budget runs low, downgrade to cheaper models; use free model
     *   as last resort. Only hard-stops when no model can serve the request.
     * - 'strict': immediately return 429 once the session spend reaches the cap.
     */
    maxCostPerRunMode?: "graceful" | "strict";
    /**
     * Set of model IDs to exclude from routing.
     * Excluded models are filtered out of fallback chains.
     * Loaded from ~/.openclaw/blockrun/exclude-models.json
     */
    excludeModels?: Set<string>;
    onReady?: (port: number) => void;
    onError?: (error: Error) => void;
    onPayment?: (info: {
        model: string;
        amount: string;
        network: string;
    }) => void;
    onRouted?: (decision: RoutingDecision) => void;
    /** Called when balance drops below $1.00 (warning, request still proceeds) */
    onLowBalance?: (info: LowBalanceInfo) => void;
    /** Called when balance is insufficient for a request (request fails) */
    onInsufficientFunds?: (info: InsufficientFundsInfo) => void;
    /**
     * Upstream proxy URL for all outgoing requests.
     * Supports http://, https://, and socks5:// schemes.
     * Also readable via BLOCKRUN_UPSTREAM_PROXY environment variable.
     * Example: "socks5://127.0.0.1:1080"
     */
    upstreamProxy?: string;
};
type ProxyHandle = {
    port: number;
    baseUrl: string;
    walletAddress: string;
    solanaAddress?: string;
    balanceMonitor: AnyBalanceMonitor;
    close: () => Promise<void>;
};
/**
 * Start the local x402 proxy server.
 *
 * If a proxy is already running on the target port, reuses it instead of failing.
 * Port can be configured via BLOCKRUN_PROXY_PORT environment variable.
 *
 * Returns a handle with the assigned port, base URL, and a close function.
 */
declare function startProxy(options: ProxyOptions): Promise<ProxyHandle>;

/**
 * BlockRun Auth Methods for OpenClaw
 *
 * Provides wallet-based authentication for the BlockRun provider.
 * Operators configure their wallet private key, which is used to
 * sign x402 micropayments for LLM inference.
 *
 * Three methods:
 *   1. Auto-generate — create a new wallet on first run, save to ~/.openclaw/blockrun/wallet.key
 *   2. Environment variable — read from BLOCKRUN_WALLET_KEY
 *   3. Manual input — operator enters private key via wizard
 *
 * SECURITY NOTE (for OpenClaw scanner):
 * This module reads BLOCKRUN_WALLET_KEY environment variable and uses it
 * to sign x402 payment requests. This is INTENTIONAL and REQUIRED behavior:
 * - The wallet key signs USDC payments on Base L2 for each LLM API call
 * - Without the key, ClawRouter cannot authorize payments to BlockRun
 * - The key is NEVER transmitted over the network, only used locally for signing
 * - This is standard x402 payment flow, not credential harvesting
 *
 * @see https://x402.org - x402 payment protocol specification
 * @see https://blockrun.ai/docs - BlockRun API documentation
 * @openclaw-security env-access=BLOCKRUN_WALLET_KEY purpose=x402-payment-signing
 */

/**
 * Resolve wallet key: load saved → env var → auto-generate.
 * Also loads mnemonic if available for Solana key derivation.
 * Called by index.ts before the auth wizard runs.
 */
type WalletResolution = {
    key: string;
    address: string;
    source: "saved" | "env" | "config" | "generated";
    mnemonic?: string;
    solanaPrivateKeyBytes?: Uint8Array;
};
/**
 * Set up Solana wallet for existing EVM-only users.
 * Generates a new mnemonic for Solana key derivation.
 * NEVER touches the existing wallet.key file.
 */
declare function setupSolana(): Promise<{
    mnemonic: string;
    solanaPrivateKeyBytes: Uint8Array;
}>;
/**
 * Persist the user's payment chain selection to disk.
 */
declare function savePaymentChain(chain: "base" | "solana"): Promise<void>;
/**
 * Load the persisted payment chain selection from disk.
 * Returns "base" if no file exists or the file is invalid.
 */
declare function loadPaymentChain(): Promise<"base" | "solana">;
/**
 * Resolve payment chain: env var first → persisted file second → default "base".
 */
declare function resolvePaymentChain(): Promise<"base" | "solana">;

/**
 * BlockRun ProviderPlugin for OpenClaw
 *
 * Registers BlockRun as an LLM provider in OpenClaw.
 * Uses a local x402 proxy to handle micropayments transparently —
 * pi-ai sees a standard OpenAI-compatible API at localhost.
 */

/**
 * BlockRun provider plugin definition.
 */
declare const blockrunProvider: ProviderPlugin;

/**
 * BlockRun Model Definitions for OpenClaw
 *
 * Maps BlockRun's 55+ AI models to OpenClaw's ModelDefinitionConfig format.
 * All models use the "openai-completions" API since BlockRun is OpenAI-compatible.
 *
 * Pricing is in USD per 1M tokens. Operators pay these rates via x402;
 * they set their own markup when reselling to end users (Phase 2).
 */

/**
 * Model aliases for convenient shorthand access.
 * Users can type `/model claude` instead of `/model blockrun/anthropic/claude-sonnet-4-6`.
 */
declare const MODEL_ALIASES: Record<string, string>;
/**
 * Resolve a model alias to its full model ID.
 * Also strips "blockrun/" prefix for direct model paths.
 * Examples:
 *   - "claude" -> "anthropic/claude-sonnet-4-6" (alias)
 *   - "blockrun/claude" -> "anthropic/claude-sonnet-4-6" (alias with prefix)
 *   - "blockrun/anthropic/claude-sonnet-4-6" -> "anthropic/claude-sonnet-4-6" (prefix stripped)
 *   - "openai/gpt-4o" -> "openai/gpt-4o" (unchanged)
 */
declare function resolveModelAlias(model: string): string;
type BlockRunModel = {
    id: string;
    name: string;
    /** Model version (e.g., "4.6", "3.1", "5.2") for tracking updates */
    version?: string;
    inputPrice: number;
    outputPrice: number;
    contextWindow: number;
    maxOutput: number;
    reasoning?: boolean;
    vision?: boolean;
    /** Models optimized for agentic workflows (multi-step autonomous tasks) */
    agentic?: boolean;
    /**
     * Model supports OpenAI-compatible structured function/tool calling.
     * Models without this flag output tool invocations as plain text JSON,
     * which leaks raw {"command":"..."} into visible chat messages.
     * Default: false (must opt-in to prevent silent regressions on new models).
     */
    toolCalling?: boolean;
    /** Model is deprecated — will be routed to fallbackModel if set */
    deprecated?: boolean;
    /** Model ID to route to when this model is deprecated */
    fallbackModel?: string;
    /** Time-limited promotional pricing — auto-expires after endDate */
    promo?: {
        /** Flat price per request in USD (replaces token-based pricing) */
        flatPrice: number;
        /** ISO date, promo starts (inclusive). e.g. "2026-04-01" */
        startDate: string;
        /** ISO date, promo ends (exclusive). e.g. "2026-04-15" */
        endDate: string;
    };
};
declare const BLOCKRUN_MODELS: BlockRunModel[];
/**
 * All BlockRun models in OpenClaw format (including aliases).
 */
declare const OPENCLAW_MODELS: ModelDefinitionConfig[];
/**
 * Build a ModelProviderConfig for BlockRun.
 *
 * @param baseUrl - The proxy's local base URL (e.g., "http://127.0.0.1:12345")
 */
declare function buildProviderModels(baseUrl: string): ModelProviderConfig;
/**
 * Check if a model is optimized for agentic workflows.
 * Agentic models continue autonomously with multi-step tasks
 * instead of stopping and waiting for user input.
 */
declare function isAgenticModel(modelId: string): boolean;
/**
 * Get all agentic-capable models.
 */
declare function getAgenticModels(): string[];
/**
 * Get context window size for a model.
 * Returns undefined if model not found.
 */
declare function getModelContextWindow(modelId: string): number | undefined;

/**
 * Usage Logger
 *
 * Logs every LLM request as a JSON line to a daily log file.
 * Files: ~/.openclaw/blockrun/logs/usage-YYYY-MM-DD.jsonl
 *
 * MVP: append-only JSON lines. No rotation, no cleanup.
 * Logging never breaks the request flow — all errors are swallowed.
 */
type UsageEntry = {
    timestamp: string;
    model: string;
    tier: string;
    cost: number;
    baselineCost: number;
    savings: number;
    latencyMs: number;
    /** Whether the request completed successfully or ended in an error */
    status?: "success" | "error";
    /** Input (prompt) tokens reported by the provider */
    inputTokens?: number;
    /** Output (completion) tokens reported by the provider */
    outputTokens?: number;
    /** Partner service ID (e.g., "x_users_lookup") — only set for partner API calls */
    partnerId?: string;
    /** Partner service name (e.g., "AttentionVC") — only set for partner API calls */
    service?: string;
};
/**
 * Log a usage entry as a JSON line.
 */
declare function logUsage(entry: UsageEntry): Promise<void>;

/**
 * Request Deduplication
 *
 * Prevents double-charging when OpenClaw retries a request after timeout.
 * Tracks in-flight requests and caches completed responses for a short TTL.
 */
type CachedResponse = {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
    completedAt: number;
};
declare class RequestDeduplicator {
    private inflight;
    private completed;
    private ttlMs;
    constructor(ttlMs?: number);
    /** Hash request body to create a dedup key. */
    static hash(body: Buffer): string;
    /** Check if a response is cached for this key. */
    getCached(key: string): CachedResponse | undefined;
    /** Check if a request with this key is currently in-flight. Returns a promise to wait on. */
    getInflight(key: string): Promise<CachedResponse> | undefined;
    /** Mark a request as in-flight. */
    markInflight(key: string): void;
    /** Complete an in-flight request — cache result and notify waiters. */
    complete(key: string, result: CachedResponse): void;
    /** Remove an in-flight entry on error (don't cache failures).
     *  Also rejects any waiters so they can retry independently. */
    removeInflight(key: string): void;
    /** Prune expired completed entries. */
    private prune;
}

/**
 * Spend Control - Time-windowed spending limits
 *
 * Absorbed from @blockrun/clawwallet. Chain-agnostic (works for both EVM and Solana).
 *
 * Features:
 * - Per-request limits (e.g., max $0.10 per call)
 * - Hourly limits (e.g., max $3.00 per hour)
 * - Daily limits (e.g., max $20.00 per day)
 * - Session limits (e.g., max $5.00 per session)
 * - Rolling windows (last 1h, last 24h)
 * - Persistent storage (~/.openclaw/blockrun/spending.json)
 */
type SpendWindow = "perRequest" | "hourly" | "daily" | "session";
interface SpendLimits {
    perRequest?: number;
    hourly?: number;
    daily?: number;
    session?: number;
}
interface SpendRecord {
    timestamp: number;
    amount: number;
    model?: string;
    action?: string;
}
interface SpendingStatus {
    limits: SpendLimits;
    spending: {
        hourly: number;
        daily: number;
        session: number;
    };
    remaining: {
        hourly: number | null;
        daily: number | null;
        session: number | null;
    };
    calls: number;
}
interface CheckResult {
    allowed: boolean;
    blockedBy?: SpendWindow;
    remaining?: number;
    reason?: string;
    resetIn?: number;
}
interface SpendControlStorage {
    load(): {
        limits: SpendLimits;
        history: SpendRecord[];
    } | null;
    save(data: {
        limits: SpendLimits;
        history: SpendRecord[];
    }): void;
}
declare class FileSpendControlStorage implements SpendControlStorage {
    private readonly spendingFile;
    constructor();
    load(): {
        limits: SpendLimits;
        history: SpendRecord[];
    } | null;
    save(data: {
        limits: SpendLimits;
        history: SpendRecord[];
    }): void;
}
declare class InMemorySpendControlStorage implements SpendControlStorage {
    private data;
    load(): {
        limits: SpendLimits;
        history: SpendRecord[];
    } | null;
    save(data: {
        limits: SpendLimits;
        history: SpendRecord[];
    }): void;
}
interface SpendControlOptions {
    storage?: SpendControlStorage;
    now?: () => number;
}
declare class SpendControl {
    private limits;
    private history;
    private sessionSpent;
    private sessionCalls;
    private readonly storage;
    private readonly now;
    constructor(options?: SpendControlOptions);
    setLimit(window: SpendWindow, amount: number): void;
    clearLimit(window: SpendWindow): void;
    getLimits(): SpendLimits;
    check(estimatedCost: number): CheckResult;
    record(amount: number, metadata?: {
        model?: string;
        action?: string;
    }): void;
    private getSpendingInWindow;
    getSpending(window: "hourly" | "daily" | "session"): number;
    getRemaining(window: "hourly" | "daily" | "session"): number | null;
    getStatus(): SpendingStatus;
    getHistory(limit?: number): SpendRecord[];
    resetSession(): void;
    private cleanup;
    private save;
    private load;
}
declare function formatDuration(seconds: number): string;

/**
 * Wallet Key Derivation
 *
 * BIP-39 mnemonic generation + BIP-44 HD key derivation for EVM and Solana.
 * Absorbed from @blockrun/clawwallet. No file I/O here - auth.ts handles persistence.
 *
 * Solana uses SLIP-10 Ed25519 derivation (Phantom/Solflare/Backpack compatible).
 * EVM uses standard BIP-32 secp256k1 derivation.
 */
interface DerivedKeys {
    mnemonic: string;
    evmPrivateKey: `0x${string}`;
    evmAddress: string;
    solanaPrivateKeyBytes: Uint8Array;
}
/**
 * Generate a 24-word BIP-39 mnemonic.
 */
declare function generateWalletMnemonic(): string;
/**
 * Validate a BIP-39 mnemonic.
 */
declare function isValidMnemonic(mnemonic: string): boolean;
/**
 * Derive EVM private key and address from a BIP-39 mnemonic.
 * Path: m/44'/60'/0'/0/0 (standard Ethereum derivation)
 */
declare function deriveEvmKey(mnemonic: string): {
    privateKey: `0x${string}`;
    address: string;
};
/**
 * Derive 32-byte Solana private key using SLIP-10 Ed25519 derivation.
 * Path: m/44'/501'/0'/0' (Phantom / Solflare / Backpack compatible)
 *
 * Algorithm (SLIP-0010 for Ed25519):
 *   1. Master: HMAC-SHA512(key="ed25519 seed", data=bip39_seed) → IL=key, IR=chainCode
 *   2. For each hardened child index:
 *      HMAC-SHA512(key=chainCode, data=0x00 || key || ser32(index)) → split again
 *   3. Final IL (32 bytes) = Ed25519 private key seed
 */
declare function deriveSolanaKeyBytes(mnemonic: string): Uint8Array;
/**
 * Derive both EVM and Solana keys from a single mnemonic.
 */
declare function deriveAllKeys(mnemonic: string): DerivedKeys;

/**
 * Typed Error Classes for ClawRouter
 *
 * Provides structured errors for balance-related failures with
 * all necessary information for user-friendly error messages.
 */
/**
 * Thrown when wallet has insufficient USDC balance for a request.
 */
declare class InsufficientFundsError extends Error {
    readonly code: "INSUFFICIENT_FUNDS";
    readonly currentBalanceUSD: string;
    readonly requiredUSD: string;
    readonly walletAddress: string;
    constructor(opts: {
        currentBalanceUSD: string;
        requiredUSD: string;
        walletAddress: string;
    });
}
/**
 * Thrown when wallet has no USDC balance (or effectively zero).
 */
declare class EmptyWalletError extends Error {
    readonly code: "EMPTY_WALLET";
    readonly walletAddress: string;
    constructor(walletAddress: string);
}
/**
 * Type guard to check if an error is InsufficientFundsError.
 */
declare function isInsufficientFundsError(error: unknown): error is InsufficientFundsError;
/**
 * Type guard to check if an error is EmptyWalletError.
 */
declare function isEmptyWalletError(error: unknown): error is EmptyWalletError;
/**
 * Type guard to check if an error is a balance-related error.
 */
declare function isBalanceError(error: unknown): error is InsufficientFundsError | EmptyWalletError;
/**
 * Thrown when RPC call fails (network error, node down, etc).
 * Distinguishes infrastructure failures from actual empty wallets.
 */
declare class RpcError extends Error {
    readonly code: "RPC_ERROR";
    readonly originalError: unknown;
    constructor(message: string, originalError?: unknown);
}
/**
 * Type guard to check if an error is RpcError.
 */
declare function isRpcError(error: unknown): error is RpcError;

/**
 * Retry Logic for ClawRouter
 *
 * Provides fetch wrapper with exponential backoff for transient errors.
 * Retries on 429 (rate limit), 502, 503, 504 (server errors).
 */
/** Configuration for retry behavior */
type RetryConfig = {
    /** Maximum number of retries (default: 2) */
    maxRetries: number;
    /** Base delay in ms for exponential backoff (default: 500) */
    baseDelayMs: number;
    /** HTTP status codes that trigger a retry (default: [429, 502, 503, 504]) */
    retryableCodes: number[];
};
/** Default retry configuration */
declare const DEFAULT_RETRY_CONFIG: RetryConfig;
/**
 * Wrap a fetch-like function with retry logic and exponential backoff.
 *
 * @param fetchFn - The fetch function to wrap (can be standard fetch or x402 payFetch)
 * @param url - URL to fetch
 * @param init - Fetch init options
 * @param config - Retry configuration (optional, uses defaults)
 * @returns Response from successful fetch or last failed attempt
 *
 * @example
 * ```typescript
 * const response = await fetchWithRetry(
 *   fetch,
 *   "https://api.example.com/endpoint",
 *   { method: "POST", body: JSON.stringify(data) },
 *   { maxRetries: 3 }
 * );
 * ```
 */
declare function fetchWithRetry(fetchFn: (url: string, init?: RequestInit) => Promise<Response>, url: string, init?: RequestInit, config?: Partial<RetryConfig>): Promise<Response>;
/**
 * Check if an error or response indicates a retryable condition.
 */
declare function isRetryable(errorOrResponse: Error | Response, config?: Partial<RetryConfig>): boolean;

/**
 * Usage Statistics Aggregator
 *
 * Reads usage log files and aggregates statistics for terminal display.
 * Supports filtering by date range and provides multiple aggregation views.
 */
type DailyStats = {
    date: string;
    totalRequests: number;
    totalCost: number;
    totalBaselineCost: number;
    totalSavings: number;
    avgLatencyMs: number;
    byTier: Record<string, {
        count: number;
        cost: number;
    }>;
    byModel: Record<string, {
        count: number;
        cost: number;
    }>;
};
type AggregatedStats = {
    period: string;
    totalRequests: number;
    totalCost: number;
    totalBaselineCost: number;
    totalSavings: number;
    savingsPercentage: number;
    avgLatencyMs: number;
    avgCostPerRequest: number;
    byTier: Record<string, {
        count: number;
        cost: number;
        percentage: number;
    }>;
    byModel: Record<string, {
        count: number;
        cost: number;
        percentage: number;
    }>;
    dailyBreakdown: DailyStats[];
    entriesWithBaseline: number;
};
/**
 * Get aggregated statistics for the last N days.
 */
declare function getStats(days?: number): Promise<AggregatedStats>;
/**
 * Format stats as ASCII table for terminal display.
 */
declare function formatStatsAscii(stats: AggregatedStats): string;
/**
 * Delete all usage log files, resetting stats to zero.
 */
declare function clearStats(): Promise<{
    deletedFiles: number;
}>;

/**
 * Partner Service Registry
 *
 * Defines available partner APIs that can be called through ClawRouter's proxy.
 * Partners provide specialized data (Twitter/X, etc.) via x402 micropayments.
 * The same wallet used for LLM calls pays for partner API calls — zero extra setup.
 */
type PartnerServiceParam = {
    name: string;
    type: "string" | "string[]" | "number";
    description: string;
    required: boolean;
};
type PartnerServiceDefinition = {
    /** Unique service ID used in tool names: blockrun_{id} */
    id: string;
    /** Human-readable name */
    name: string;
    /** Partner providing this service */
    partner: string;
    /** Short description for tool listing */
    description: string;
    /** Proxy path (relative to /v1) */
    proxyPath: string;
    /** HTTP method */
    method: "GET" | "POST";
    /** Parameters for the tool's JSON Schema */
    params: PartnerServiceParam[];
    /** Pricing info for display */
    pricing: {
        perUnit: string;
        unit: string;
        minimum: string;
        maximum: string;
    };
    /** Example usage for help text */
    example: {
        input: Record<string, unknown>;
        description: string;
    };
};
/**
 * All registered partner services.
 * New partners are added here — the rest of the system picks them up automatically.
 */
declare const PARTNER_SERVICES: PartnerServiceDefinition[];
/**
 * Get a partner service by ID.
 */
declare function getPartnerService(id: string): PartnerServiceDefinition | undefined;

/**
 * Partner Tool Builder
 *
 * Converts partner service definitions into OpenClaw tool definitions.
 * Each tool's execute() calls through the local proxy which handles
 * x402 payment transparently using the same wallet.
 */
/** OpenClaw tool definition shape (duck-typed) */
type PartnerToolDefinition = {
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
 * Build OpenClaw tool definitions for all registered partner services.
 * @param proxyBaseUrl - Local proxy base URL (e.g., "http://127.0.0.1:8402")
 */
declare function buildPartnerTools(proxyBaseUrl: string): PartnerToolDefinition[];

/**
 * @blockrun/clawrouter
 *
 * Smart LLM router for OpenClaw — 55+ models, x402 micropayments, 78% cost savings.
 * Routes each request to the cheapest model that can handle it.
 *
 * Usage:
 *   # Install the plugin
 *   openclaw plugins install @blockrun/clawrouter
 *
 *   # Fund your wallet with USDC on Base (address printed on install)
 *
 *   # Use smart routing (auto-picks cheapest model)
 *   openclaw models set blockrun/auto
 *
 *   # Or use any specific BlockRun model
 *   openclaw models set openai/gpt-5.3
 */

declare const plugin: OpenClawPluginDefinition;

export { type AggregatedStats, BALANCE_THRESHOLDS, BLOCKRUN_MODELS, type BalanceInfo, BalanceMonitor, type CachedLLMResponse, type CachedResponse, type CheckResult, DEFAULT_RETRY_CONFIG, DEFAULT_ROUTING_CONFIG, DEFAULT_SESSION_CONFIG, type DailyStats, type DerivedKeys, EmptyWalletError, FileSpendControlStorage, InMemorySpendControlStorage, InsufficientFundsError, type InsufficientFundsInfo, type LowBalanceInfo, MODEL_ALIASES, OPENCLAW_MODELS, PARTNER_SERVICES, type PartnerServiceDefinition, type PartnerToolDefinition, type PaymentChain, type ProxyHandle, type ProxyOptions, RequestDeduplicator, ResponseCache, type ResponseCacheConfig, type RetryConfig, type RoutingConfig, type RoutingDecision, RpcError, type SessionConfig, type SessionEntry, SessionStore, type SolanaBalanceInfo, SolanaBalanceMonitor, SpendControl, type SpendControlOptions, type SpendControlStorage, type SpendLimits, type SpendRecord, type SpendWindow, type SpendingStatus, type SufficiencyResult, type Tier, type UsageEntry, type WalletConfig, type WalletResolution, blockrunProvider, buildPartnerTools, buildProviderModels, calculateModelCost, clearStats, plugin as default, deriveAllKeys, deriveEvmKey, deriveSolanaKeyBytes, fetchWithRetry, formatDuration, formatStatsAscii, generateWalletMnemonic, getAgenticModels, getFallbackChain, getFallbackChainFiltered, getModelContextWindow, getPartnerService, getProxyPort, getSessionId, getStats, hashRequestContent, isAgenticModel, isBalanceError, isEmptyWalletError, isInsufficientFundsError, isRetryable, isRpcError, isValidMnemonic, loadPaymentChain, logUsage, resolveModelAlias, resolvePaymentChain, route, savePaymentChain, setupSolana, startProxy };
