import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const DB_PATH = path.join(os.homedir(), '.claw-proxy', 'shadow.db');

export interface ShadowEntry {
  timestamp: string;
  session_id: string;
  agent: string;
  actual_model: string;
  actual_input_tokens: number;
  actual_output_tokens: number;
  actual_cost: number;
  routed_tier: string;
  routed_model: string;
  routed_cost_estimate: number;
  savings: number;
  confidence: number;
}

export interface SessionAwareEntry {
  timestamp: string;
  session_id: string;
  agent: string;
  actual_model: string;
  actual_input_tokens: number;
  actual_output_tokens: number;
  actual_cost: number;
  per_msg_tier: string;
  per_msg_model: string;
  per_msg_cost: number;
  session_tier: string;
  session_model: string;
  session_cost: number;
  savings_per_msg: number;
  savings_session: number;
}

export interface ShadowSummary {
  per_message: {
    total_actual: number;
    total_routed: number;
    savings: number;
    savings_pct: number;
  };
  session_aware: {
    total_actual: number;
    total_routed: number;
    savings: number;
    savings_pct: number;
  };
}

export class ShadowDB {
  private db: Database.Database;

  constructor() {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    this.db = new Database(DB_PATH);
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shadow_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        session_id TEXT,
        agent TEXT,
        actual_model TEXT,
        actual_input_tokens INTEGER,
        actual_output_tokens INTEGER,
        actual_cost REAL,
        routed_tier TEXT,
        routed_model TEXT,
        routed_cost_estimate REAL,
        savings REAL,
        confidence REAL
      );

      CREATE TABLE IF NOT EXISTS shadow_routing_session_aware (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        session_id TEXT,
        agent TEXT,
        actual_model TEXT,
        actual_input_tokens INTEGER,
        actual_output_tokens INTEGER,
        actual_cost REAL,
        per_msg_tier TEXT,
        per_msg_model TEXT,
        per_msg_cost REAL,
        session_tier TEXT,
        session_model TEXT,
        session_cost REAL,
        savings_per_msg REAL,
        savings_session REAL
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        file_path TEXT PRIMARY KEY,
        last_line_processed INTEGER
      );
    `);
  }

  insert(entry: ShadowEntry) {
    const stmt = this.db.prepare(`
      INSERT INTO shadow_routing (
        timestamp, session_id, agent, actual_model,
        actual_input_tokens, actual_output_tokens, actual_cost,
        routed_tier, routed_model, routed_cost_estimate, savings, confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.timestamp, entry.session_id, entry.agent, entry.actual_model,
      entry.actual_input_tokens, entry.actual_output_tokens, entry.actual_cost,
      entry.routed_tier, entry.routed_model, entry.routed_cost_estimate,
      entry.savings, entry.confidence
    );
  }

  getLastProcessedLine(filePath: string): number {
    const stmt = this.db.prepare('SELECT last_line_processed FROM sync_state WHERE file_path = ?');
    const row = stmt.get(filePath) as { last_line_processed: number } | undefined;
    return row?.last_line_processed ?? 0;
  }

  updateSyncState(filePath: string, lastLine: number) {
    const stmt = this.db.prepare(`
      INSERT INTO sync_state (file_path, last_line_processed)
      VALUES (?, ?)
      ON CONFLICT(file_path) DO UPDATE SET last_line_processed = ?
    `);
    stmt.run(filePath, lastLine, lastLine);
  }

  getTotalSavings(): number {
    const stmt = this.db.prepare('SELECT SUM(savings) as total FROM shadow_routing');
    const row = stmt.get() as { total: number | null };
    return row.total ?? 0;
  }

  insertSessionAware(entry: SessionAwareEntry) {
    const stmt = this.db.prepare(`
      INSERT INTO shadow_routing_session_aware (
        timestamp, session_id, agent, actual_model,
        actual_input_tokens, actual_output_tokens, actual_cost,
        per_msg_tier, per_msg_model, per_msg_cost,
        session_tier, session_model, session_cost,
        savings_per_msg, savings_session
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.timestamp, entry.session_id, entry.agent, entry.actual_model,
      entry.actual_input_tokens, entry.actual_output_tokens, entry.actual_cost,
      entry.per_msg_tier, entry.per_msg_model, entry.per_msg_cost,
      entry.session_tier, entry.session_model, entry.session_cost,
      entry.savings_per_msg, entry.savings_session
    );
  }

  getAllEntries(): ShadowEntry[] {
    const stmt = this.db.prepare('SELECT * FROM shadow_routing ORDER BY session_id, timestamp');
    return stmt.all() as ShadowEntry[];
  }

  clearSessionAware() {
    this.db.exec('DELETE FROM shadow_routing_session_aware');
  }

  getSummary(): ShadowSummary {
    const perMsg = this.db.prepare(`
      SELECT 
        SUM(actual_cost) as total_actual,
        SUM(routed_cost_estimate) as total_routed
      FROM shadow_routing
    `).get() as { total_actual: number; total_routed: number };

    const sessionAware = this.db.prepare(`
      SELECT 
        SUM(actual_cost) as total_actual,
        SUM(session_cost) as total_routed
      FROM shadow_routing_session_aware
    `).get() as { total_actual: number; total_routed: number };

    const perMsgSavings = (perMsg.total_actual || 0) - (perMsg.total_routed || 0);
    const sessionSavings = (sessionAware.total_actual || 0) - (sessionAware.total_routed || 0);

    return {
      per_message: {
        total_actual: perMsg.total_actual || 0,
        total_routed: perMsg.total_routed || 0,
        savings: perMsgSavings,
        savings_pct: perMsg.total_actual ? (perMsgSavings / perMsg.total_actual) * 100 : 0
      },
      session_aware: {
        total_actual: sessionAware.total_actual || 0,
        total_routed: sessionAware.total_routed || 0,
        savings: sessionSavings,
        savings_pct: sessionAware.total_actual ? (sessionSavings / sessionAware.total_actual) * 100 : 0
      }
    };
  }

  close() {
    this.db.close();
  }
}
