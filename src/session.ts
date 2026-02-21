/**
 * Session Persistence Store
 *
 * Tracks model selections per session to prevent model switching mid-task.
 * When a session is active, the router will continue using the same model
 * instead of re-routing each request.
 */

export type SessionEntry = {
  model: string;
  tier: string;
  routingProfile?: "free" | "eco" | "auto" | "premium";
  createdAt: number;
  lastUsedAt: number;
  requestCount: number;
};

export type SessionConfig = {
  /** Enable session persistence (default: false) */
  enabled: boolean;
  /** Session timeout in ms (default: 30 minutes) */
  timeoutMs: number;
  /** Header name for session ID (default: X-Session-ID) */
  headerName: string;
};

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  enabled: false,
  timeoutMs: 30 * 60 * 1000, // 30 minutes
  headerName: "x-session-id",
};

/**
 * Session persistence store for maintaining model selections.
 */
export class SessionStore {
  private sessions: Map<string, SessionEntry> = new Map();
  private config: SessionConfig;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<SessionConfig> = {}) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config };

    // Start cleanup interval (every 5 minutes)
    if (this.config.enabled) {
      this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    }
  }

  /**
   * Get the pinned model for a session, if any.
   */
  getSession(sessionId: string): SessionEntry | undefined {
    if (!this.config.enabled || !sessionId) {
      return undefined;
    }

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return undefined;
    }

    // Check if session has expired
    const now = Date.now();
    if (now - entry.lastUsedAt > this.config.timeoutMs) {
      this.sessions.delete(sessionId);
      return undefined;
    }

    return entry;
  }

  /**
   * Pin a model to a session.
   */
  setSession(
    sessionId: string,
    model: string,
    tier: string,
    routingProfile?: "free" | "eco" | "auto" | "premium",
  ): void {
    if (!this.config.enabled || !sessionId) {
      return;
    }

    const existing = this.sessions.get(sessionId);
    const now = Date.now();

    if (existing) {
      existing.lastUsedAt = now;
      existing.requestCount++;
      // Update model if different (e.g., fallback)
      if (existing.model !== model) {
        existing.model = model;
        existing.tier = tier;
      }
      existing.routingProfile = routingProfile;
    } else {
      this.sessions.set(sessionId, {
        model,
        tier,
        routingProfile,
        createdAt: now,
        lastUsedAt: now,
        requestCount: 1,
      });
    }
  }

  /**
   * Touch a session to extend its timeout.
   */
  touchSession(sessionId: string): void {
    if (!this.config.enabled || !sessionId) {
      return;
    }

    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.lastUsedAt = Date.now();
      entry.requestCount++;
    }
  }

  /**
   * Clear a specific session.
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Clear all sessions.
   */
  clearAll(): void {
    this.sessions.clear();
  }

  /**
   * Get session stats for debugging.
   */
  getStats(): { count: number; sessions: Array<{ id: string; model: string; age: number }> } {
    const now = Date.now();
    const sessions = Array.from(this.sessions.entries()).map(([id, entry]) => ({
      id: id.slice(0, 8) + "...",
      model: entry.model,
      age: Math.round((now - entry.createdAt) / 1000),
    }));
    return { count: this.sessions.size, sessions };
  }

  /**
   * Clean up expired sessions.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastUsedAt > this.config.timeoutMs) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Stop the cleanup interval.
   */
  close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

/**
 * Generate a session ID from request headers or create a default.
 */
export function getSessionId(
  headers: Record<string, string | string[] | undefined>,
  headerName: string = DEFAULT_SESSION_CONFIG.headerName,
): string | undefined {
  const value = headers[headerName] || headers[headerName.toLowerCase()];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return undefined;
}
