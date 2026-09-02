import { RoutingConfig, RoutingDecision } from '@blockrun/router-core';
export { DEFAULT_ROUTING_CONFIG, RouterOptions, RoutingConfig, RoutingDecision, TaskType, Tier, calculateModelCost, filterCandidatesByCapacity, getFallbackChain, getFallbackChainFiltered, inferToolRequirement, route } from '@blockrun/router-core';
import { x402Client } from '@x402/fetch';

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
type OpenClawConfig = Record<string, unknown> & {
    models?: {
        providers?: Record<string, ModelProviderConfig>;
    };
    agents?: Record<string, unknown>;
    mcp?: {
        servers?: Record<string, unknown>;
    };
    tools?: {
        web?: {
            search?: Record<string, unknown> & {
                provider?: string;
                enabled?: boolean;
            };
        };
    };
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
type VideoGenerationResolution = "480P" | "720P" | "768P" | "1080P";
type GeneratedVideoAsset = {
    buffer: Buffer;
    mimeType: string;
    fileName?: string;
    metadata?: Record<string, unknown>;
};
type VideoGenerationSourceAsset = {
    url?: string;
    buffer?: Buffer;
    mimeType?: string;
    fileName?: string;
    metadata?: Record<string, unknown>;
};
type VideoGenerationRequest = {
    provider: string;
    model: string;
    prompt: string;
    cfg: Record<string, unknown>;
    agentDir?: string;
    timeoutMs?: number;
    size?: string;
    aspectRatio?: string;
    resolution?: VideoGenerationResolution;
    durationSeconds?: number;
    audio?: boolean;
    watermark?: boolean;
    inputImages?: VideoGenerationSourceAsset[];
    inputVideos?: VideoGenerationSourceAsset[];
};
type VideoGenerationResult = {
    videos: GeneratedVideoAsset[];
    model?: string;
    metadata?: Record<string, unknown>;
};
type VideoGenerationModeCapabilities = {
    maxVideos?: number;
    maxInputImages?: number;
    maxInputVideos?: number;
    maxDurationSeconds?: number;
    supportedDurationSeconds?: readonly number[];
    supportsSize?: boolean;
    supportsAspectRatio?: boolean;
    supportsResolution?: boolean;
    supportsAudio?: boolean;
    supportsWatermark?: boolean;
};
type VideoGenerationTransformCapabilities = VideoGenerationModeCapabilities & {
    enabled: boolean;
};
type VideoGenerationProviderCapabilities = VideoGenerationModeCapabilities & {
    generate?: VideoGenerationModeCapabilities;
    imageToVideo?: VideoGenerationTransformCapabilities;
    videoToVideo?: VideoGenerationTransformCapabilities;
};
type VideoGenerationProviderPlugin = {
    id: string;
    aliases?: string[];
    label?: string;
    defaultModel?: string;
    models?: string[];
    capabilities: VideoGenerationProviderCapabilities;
    isConfigured?: (ctx: {
        cfg?: Record<string, unknown>;
    }) => boolean;
    generateVideo: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>;
};
type WebSearchProviderToolDefinition = {
    description: string;
    parameters: unknown;
    execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
};
type WebSearchProviderContext = {
    config: OpenClawConfig;
    searchConfig?: Record<string, unknown>;
    runtimeMetadata?: Record<string, unknown>;
};
type WebSearchProviderPlugin = {
    id: string;
    label: string;
    hint: string;
    onboardingScopes?: Array<"text-inference">;
    requiresCredential?: boolean;
    credentialLabel?: string;
    envVars: string[];
    placeholder: string;
    signupUrl: string;
    docsUrl?: string;
    autoDetectOrder?: number;
    credentialPath: string;
    inactiveSecretPaths?: string[];
    getCredentialValue: (searchConfig?: Record<string, unknown>) => unknown;
    setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) => void;
    getConfiguredCredentialValue?: (config?: OpenClawConfig) => unknown;
    setConfiguredCredentialValue?: (configTarget: OpenClawConfig, value: unknown) => void;
    applySelectionConfig?: (config: OpenClawConfig) => OpenClawConfig;
    resolveRuntimeMetadata?: (ctx: Record<string, unknown>) => unknown;
    createTool: (ctx: WebSearchProviderContext) => WebSearchProviderToolDefinition | null;
};
type OpenClawPluginApi = {
    id: string;
    name: string;
    version?: string;
    description?: string;
    source: string;
    config: OpenClawConfig;
    pluginConfig?: Record<string, unknown>;
    logger: PluginLogger;
    registerProvider: (provider: ProviderPlugin) => void;
    registerImageGenerationProvider: (provider: ImageGenerationProviderPlugin) => void;
    registerMusicGenerationProvider: (provider: MusicGenerationProviderPlugin) => void;
    registerVideoGenerationProvider?: (provider: VideoGenerationProviderPlugin) => void;
    registerWebSearchProvider?: (provider: WebSearchProviderPlugin) => void;
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
    reload?: {
        noopPrefixes?: string[];
    };
};

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
 * Spend Control - Time-windowed spending limits and counterparty policy
 *
 * Absorbed from @blockrun/clawwallet. Chain-agnostic (works for both EVM and Solana).
 *
 * Features:
 * - Per-request limits (e.g., max $0.10 per call)
 * - Hourly limits (e.g., max $3.00 per hour)
 * - Daily limits (e.g., max $20.00 per day)
 * - Session limits (e.g., max $5.00 per session)
 * - Rolling windows (last 1h, last 24h)
 * - Counterparty policy: payee allow/deny, network and asset allowlists
 * - Fail-closed enforcement before the signer, via the x402 pre-sign hook
 * - Persistent storage (~/.openclaw/blockrun/spending.json)
 */

type SpendWindow = "perRequest" | "hourly" | "daily" | "session";
/**
 * Counterparty/network/asset allow-or-deny lists. Default-off: a list only
 * takes effect once configured via setPolicy(). `allowedPayees`/`blockedPayees`
 * are both supported (block always wins if both are set); network and asset
 * are allowlist-only, matching what a caller can realistically enumerate.
 */
type PolicyList = "allowedPayees" | "blockedPayees" | "allowedNetworks" | "allowedAssets";
/** Base mainnet, as carried on x402 `selectedRequirements.network`. */
declare const CAIP2_BASE = "eip155:8453";
/** Solana mainnet genesis, as carried on x402 `selectedRequirements.network`. */
declare const CAIP2_SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/**
 * A policy list on disk is present but unusable. Thrown rather than swallowed:
 * silently dropping a corrupted allow/deny list would widen what the agent may
 * pay, which is the one direction this file must never fail in. Callers
 * classify on `instanceof`, not on the message text.
 */
declare class MalformedSpendPolicyError extends Error {
    constructor(key: string);
}
interface SpendLimits {
    perRequest?: number;
    hourly?: number;
    daily?: number;
    session?: number;
    allowedPayees?: string[];
    blockedPayees?: string[];
    /**
     * CAIP-2 identifiers matching x402 `selectedRequirements.network`
     * (e.g. `eip155:8453`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`).
     * Nicknames such as `base` or `solana` do not match and fail closed.
     */
    allowedNetworks?: string[];
    allowedAssets?: string[];
}
/**
 * Counterparty details for a pending payment, passed to check() alongside
 * the estimated cost. EVM `payTo` values matching `0x` + 40 hex are compared
 * case-insensitively; anything else (including Solana base58) is exact-match.
 */
interface CounterpartyInfo {
    payTo?: string;
    network?: string;
    asset?: string;
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
    blockedByPolicy?: PolicyList;
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
    /**
     * Optional: persist history without touching stored limits. Implement it to
     * keep recorded spend from overwriting an operator's policy edits. Falls
     * back to save() when absent.
     */
    saveHistory?(history: SpendRecord[]): void;
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
    /**
     * Persist history while leaving the stored limits exactly as they are on
     * disk. Recording spend must not rewrite policy: the proxy reads limits once
     * at startup, so writing its in-memory copy back on every payment would
     * erase an operator's hand-edit to spending.json seconds after they made it.
     */
    saveHistory(history: SpendRecord[]): void;
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
    private pending;
    private reservationSeq;
    /** Limits we loaded and have not changed; history-only saves must not clobber operator edits. */
    private limitsDirty;
    /** Set when spending.json held an unusable policy list: refuse every payment. */
    private policyFileBroken?;
    private readonly storage;
    private readonly now;
    constructor(options?: SpendControlOptions);
    setLimit(window: SpendWindow, amount: number): void;
    clearLimit(window: SpendWindow): void;
    setPolicy(list: PolicyList, values: string[]): void;
    clearPolicy(list: PolicyList): void;
    getLimits(): SpendLimits;
    check(estimatedCost: number, counterparty?: CounterpartyInfo): CheckResult;
    record(amount: number, metadata?: {
        model?: string;
        action?: string;
    }): void;
    /** True when any window that this module can compare an amount against is set. */
    hasAmountLimits(): boolean;
    /** True when a window spans more than one request, so reservations matter. */
    hasAggregateLimits(): boolean;
    /**
     * Hold `amount` against the aggregate windows before a payment is signed.
     *
     * Reservations live in memory only and are never persisted: an unsettled
     * reservation is not spend, and writing it to disk is what made a failed
     * signer permanently consume budget. They expire on their own so a caller
     * that never settles or releases (process killed mid-payment, a transport
     * that hangs past the payment timeout) cannot wedge the window shut.
     */
    reserve(amount: number): string;
    /** Convert a reservation into recorded spend (the payment was signed). */
    settleReservation(id: string, metadata?: {
        model?: string;
        action?: string;
    }): void;
    /** Drop a reservation without recording spend (the payment was never signed). */
    releaseReservation(id: string): void;
    /** Total currently held but not yet settled. */
    private pendingTotal;
    private expireReservations;
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
/**
 * Thrown from the pre-sign hook when policy or an amount window refuses.
 *
 * A deliberate refusal must never be mistaken for a transient upstream fault:
 * the proxy's fallback loop retries provider errors across every paid model
 * and then silently lands on a free one, which would hide the denial from the
 * caller entirely. Callers classify on `instanceof` (see `proxy.ts`), so the
 * message text is free to change. It keeps the `Payment creation aborted:`
 * prefix that `@x402/core` uses for its own aborts so existing log greps and
 * error matchers still see a familiar string.
 */
declare class SpendPolicyError extends Error {
    readonly blockedBy?: SpendWindow;
    readonly blockedByPolicy?: PolicyList;
    constructor(reason: string, blocked?: {
        blockedBy?: SpendWindow;
        blockedByPolicy?: PolicyList;
    });
}
/**
 * Register the fail-closed spend-policy hook on an x402 client.
 *
 * Reservations are keyed on the `selectedRequirements` object, which
 * `@x402/core` passes by reference to the before / after / failure hooks of
 * the same `createPaymentPayload` call, so concurrent payments never settle
 * each other's reservation.
 */
declare function registerSpendPolicyHook(x402: x402Client, control: SpendControl): void;
declare function formatDuration(seconds: number): string;

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
    /**
     * `true` when the user explicitly chose this model (e.g. /model command in
     * OpenClaw or sending an explicit non-profile model in the request body).
     * Explicit pins are sticky — they're NOT overridden by tier escalation when
     * a future routing-profile request comes in. The user's intent wins.
     */
    userExplicit?: boolean;
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
     *
     * Pass `userExplicit: true` when the user explicitly chose this model
     * (e.g. via /model command or by sending an explicit non-profile model).
     * Explicit pins are sticky — they survive tier-escalation comparisons so
     * that the user's choice keeps winning even if subsequent requests use a
     * routing profile that would normally re-route.
     */
    setSession(sessionId: string, model: string, tier: string, userExplicit?: boolean): void;
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
    /**
     * Payment chain: "base" or "solana". New installs persist "solana" at wallet
     * generation; absent config resolves to "base" for pre-existing installs.
     * Can also be set via CLAWROUTER_PAYMENT_CHAIN env var.
     */
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
    /** Local comparison only; it never changes the serving request or sends another completion. */
    onShadowRouted?: (comparison: {
        executed: RoutingDecision;
        shadow: RoutingDecision;
        sameModel: boolean;
        hasTools: boolean;
        hasVision: boolean;
        requiresStructuredOutput: boolean;
    }) => void;
    /** Called when balance drops below $1.00 (warning, request still proceeds) */
    onLowBalance?: (info: LowBalanceInfo) => void;
    /** Called when balance is insufficient for a request (request fails) */
    onInsufficientFunds?: (info: InsufficientFundsInfo) => void;
    /**
     * Spend / counterparty policy. Default: FileSpendControlStorage at
     * ~/.openclaw/blockrun/spending.json. Inject in tests.
     */
    spendControl?: SpendControl;
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
 * New installs persist "solana" at wallet generation, so an absent file
 * means a pre-existing install whose funds live on Base.
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
    /**
     * Permanent flat per-request price in USD (backend billingMode: "flat").
     * Unlike promo, this never expires. Takes precedence over promo.
     */
    flatPrice?: number;
};
declare const BLOCKRUN_MODELS: BlockRunModel[];
/**
 * All BlockRun models in OpenClaw format (including aliases).
 * Used for proxy-side resolution (alias → target ID), tool routing, etc.
 *
 * Catalog entries shadowed by an identically-keyed alias are excluded:
 * resolveModelAlias checks MODEL_ALIASES first, so those catalog entries are
 * unreachable and their metadata (name/pricing) would misadvertise what
 * callers actually get. The alias-derived entry carries the redirect
 * target's real metadata instead.
 */
declare const OPENCLAW_MODELS: ModelDefinitionConfig[];
declare const VISIBLE_OPENCLAW_MODELS: ModelDefinitionConfig[];
/**
 * Build a ModelProviderConfig for BlockRun.
 *
 * Returns only the TOP_MODELS-listed subset so the OpenClaw picker stays
 * focused. Hidden models are still resolvable through the proxy.
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
    /** Partner service ID (e.g., "image_generation") — only set for partner API calls */
    partnerId?: string;
    /** Partner service name (e.g., "BlockRun") — only set for partner API calls */
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
 * Partners cover prediction-market data, realtime market quotes, and image/video
 * generation — all paid via x402 micropayments on the same wallet as LLM calls.
 */
type PartnerServiceParam = {
    name: string;
    type: "string" | "string[]" | "number";
    description: string;
    required: boolean;
};
type PartnerCategory = "Prediction markets" | "Market data" | "Image & Video" | "Communications";
type PartnerServiceDefinition = {
    /** Unique service ID used in tool names: blockrun_{id} */
    id: string;
    /** Human-readable name */
    name: string;
    /** Partner providing this service */
    partner: string;
    /** Category used for grouping in the `/partners` list view */
    category: PartnerCategory;
    /** Compact one-liner used in the `/partners` list (≤ 40 chars ideal) */
    shortDescription: string;
    /** Full description used for the tool's JSON Schema (LLM sees this) */
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
 *   # Fund your wallet with USDC (Solana for new installs, Base for existing ones;
 *   # the funding address is printed on install)
 *
 *   # Use smart routing (auto-picks cheapest model)
 *   openclaw models set blockrun/auto
 *
 *   # Or use any specific BlockRun model
 *   openclaw models set openai/gpt-5.3
 */

/**
 * Detect whether BlockRun's web search provider should be disabled.
 *
 * Two opt-out paths:
 * - `BLOCKRUN_WEB_SEARCH=off` env var (case-insensitive) — for CI / one-off runs.
 * - `tools.web.search.enabled === false` in `~/.openclaw/openclaw.json` — persistent,
 *   per-user opt-out. Without a check here, `injectModelsConfig` would re-flip
 *   `enabled` to `true` on every plugin load and `register()` would always wire
 *   blockrun-exa back up.
 *
 * When disabled: `injectModelsConfig` leaves `enabled` untouched and `register()`
 * skips `registerWebSearchProvider`. The on-disk migration that strips the legacy
 * `provider: blockrun-exa` field still runs regardless — that's correctness, not
 * opt-in.
 */
declare function isBlockrunWebSearchDisabled(config?: unknown): boolean;
/**
 * Inject BlockRun models config into OpenClaw config file.
 * This is required because registerProvider() alone doesn't make models available.
 *
 * CRITICAL: This function must be idempotent and handle ALL edge cases:
 * - Config file doesn't exist (create it)
 * - Config file exists but is empty/invalid (reinitialize)
 * - blockrun provider exists but has undefined fields (fix them)
 * - Config exists but uses old port/models (update them)
 *
 * This function is called on EVERY plugin load to ensure config is always correct.
 *
 * Also strips any previously managed `mcp.servers.blockrun` entry we wrote in
 * older releases — ClawRouter no longer bundles the MCP bridge (the npx-spawned
 * grandchildren were leaking). The scrub only removes entries matching the
 * managed shape; user-defined `blockrun` MCP servers are left alone.
 */
declare function injectModelsConfig(logger: {
    info: (msg: string) => void;
}, options?: {
    forceWrite?: boolean;
}): void;
/**
 * Repair the per-agent model cache OpenClaw keeps at
 * `~/.openclaw/agents/<agent>/agent/models.json`.
 *
 * This is a THIRD model-list plane, distinct from the two in `openclaw.json`
 * (`models.providers.blockrun.models` = the picker, `agents.defaults.models` =
 * the allowlist). Nothing synced it, so it rotted independently: a machine whose
 * openclaw.json `injectModelsConfig` had just repaired to the current 47 still
 * had 155 entries here — 127 long-retired models (gpt-5.2, gpt-4.1, o1 …) plus
 * duplicate `free` / `moonshot/kimi-k2.5` rows, and none of the current
 * flagships. That is what surfaces as stale and duplicated rows in the picker.
 *
 * Only rewrites when the cache already has a `blockrun` provider — we repair our
 * own entry, never introduce one — and leaves every other provider and each
 * provider's non-`models` fields (baseUrl/api/apiKey) untouched.
 *
 * Gated like `injectModelsConfig`: outside gateway mode this is a no-op unless
 * forced. `openclaw plugins install` runs activation hooks inside a transaction,
 * and writing OpenClaw's own state from under it is what stranded users before
 * (see the baseHash note on the config write above).
 */
declare function syncAgentModelCache(logger: {
    info: (msg: string) => void;
}, options?: {
    forceWrite?: boolean;
}): void;
/**
 * Inject dummy auth profile for BlockRun into agent auth stores.
 *
 * The legacy ``auth-profiles.json`` write is now deliberately narrow:
 *
 * - Wherever ``openclaw-agent.sqlite`` exists, the SQLite auth store is
 *   authoritative. Writing the legacy JSON beside it is at best ignored, at
 *   worst a failed-closed migration trigger: since OpenClaw 2026.8.1 a
 *   leftover legacy file beside a store that holds no profiles fails auth
 *   migration for the whole agent fleet. So we never write there, and we
 *   clean up the placeholder we previously injected.
 * - The shared auth-owner directory (``main``) is managed by OpenClaw
 *   itself; a placeholder written there can shadow that state. The
 *   provider's real auth comes from the x402 proxy (and the apiKey
 *   injectModelsConfig writes into openclaw.json), so nothing is lost.
 * - Only on very old installs with no SQLite store at all do we keep the
 *   original JSON bootstrap, which those releases import.
 */
declare function injectAuthProfile(logger: {
    info: (msg: string) => void;
}): void;
/**
 * Parse a `/cr-call` args string.
 *
 * Shape: `/cr-call +14155552671 "Tell them X" [--voice nat] [--max-duration 5] [--from +1...] [--language en-US]`
 *
 * - First token starting with `+` is `to` (E.164 destination).
 * - All remaining non-flag tokens are joined into `task` (the prompt for the AI agent).
 *   Quoted spans stay intact.
 * - Flags accept both `--key value` (space-separated) and `--key=value` forms.
 */
declare function parseCallArgs(raw: string): {
    to?: string;
    task: string;
    voice?: string;
    max_duration?: number;
    from?: string;
    language?: string;
};
/**
 * Build the ImageGenerationProvider that registers BlockRun image models
 * with OpenClaw's native image generation UI.
 * Delegates to the local proxy (which handles x402 payment).
 */
declare function buildImageGenerationProvider(): ImageGenerationProviderPlugin;
/**
 * This plugin's OpenClaw id. NOT "clawrouter" — OpenClaw bundles its own plugin
 * under that id since the 2026.7.1 line, and a duplicate loses to the bundled
 * one. Kept as one constant so the manifest, the plugin definition and the
 * config migration can never drift apart. See #305.
 */
declare const BLOCKRUN_PLUGIN_ID = "blockrun-clawrouter";
declare const plugin: OpenClawPluginDefinition;

export { type AggregatedStats, BALANCE_THRESHOLDS, BLOCKRUN_MODELS, BLOCKRUN_PLUGIN_ID, type BalanceInfo, BalanceMonitor, CAIP2_BASE, CAIP2_SOLANA_MAINNET, type CachedLLMResponse, type CachedResponse, type CheckResult, type CounterpartyInfo, DEFAULT_RETRY_CONFIG, DEFAULT_SESSION_CONFIG, type DailyStats, type DerivedKeys, EmptyWalletError, FileSpendControlStorage, InMemorySpendControlStorage, InsufficientFundsError, type InsufficientFundsInfo, type LowBalanceInfo, MODEL_ALIASES, MalformedSpendPolicyError, OPENCLAW_MODELS, PARTNER_SERVICES, type PartnerServiceDefinition, type PartnerToolDefinition, type PaymentChain, type PolicyList, type ProxyHandle, type ProxyOptions, RequestDeduplicator, ResponseCache, type ResponseCacheConfig, type RetryConfig, RpcError, type SessionConfig, type SessionEntry, SessionStore, type SolanaBalanceInfo, SolanaBalanceMonitor, SpendControl, type SpendControlOptions, type SpendControlStorage, type SpendLimits, SpendPolicyError, type SpendRecord, type SpendWindow, type SpendingStatus, type SufficiencyResult, type UsageEntry, VISIBLE_OPENCLAW_MODELS, type WalletConfig, type WalletResolution, blockrunProvider, buildImageGenerationProvider, buildPartnerTools, buildProviderModels, clearStats, plugin as default, deriveAllKeys, deriveEvmKey, deriveSolanaKeyBytes, fetchWithRetry, formatDuration, formatStatsAscii, generateWalletMnemonic, getAgenticModels, getModelContextWindow, getPartnerService, getProxyPort, getSessionId, getStats, hashRequestContent, injectAuthProfile, injectModelsConfig, isAgenticModel, isBalanceError, isBlockrunWebSearchDisabled, isEmptyWalletError, isInsufficientFundsError, isRetryable, isRpcError, isValidMnemonic, loadPaymentChain, logUsage, parseCallArgs, registerSpendPolicyHook, resolveModelAlias, resolvePaymentChain, savePaymentChain, setupSolana, startProxy, syncAgentModelCache };
