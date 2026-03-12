import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { Tier } from './router/config';
import { loadConfig } from './config';

export class SessionManager {
  private db: Database.Database;
  
  constructor() {
    const dbDir = path.join(os.homedir(), '.claw-proxy');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    this.db = new Database(path.join(dbDir, 'sessions.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        last_activity INTEGER NOT NULL,
        request_hashes TEXT NOT NULL,
        strike_count INTEGER NOT NULL
      )
    `);
  }
  
  getOrCreate(sessionId: string | undefined, messages: any[], initialTier: Tier): { sessionId: string, tier: Tier, escalated: boolean } {
    this.cleanup();
    
    const id = sessionId || this.generateSessionId(messages);
    const now = Date.now();
    const config = loadConfig();
    
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    
    if (!row) {
      this.db.prepare('INSERT INTO sessions (id, tier, last_activity, request_hashes, strike_count) VALUES (?, ?, ?, ?, ?)').run(id, initialTier, now, '[]', 0);
      return { sessionId: id, tier: initialTier, escalated: false };
    }
    
    let session = {
      tier: row.tier as Tier,
      lastActivity: row.last_activity,
      requestHashes: JSON.parse(row.request_hashes) as string[],
      strikeCount: row.strike_count
    };
    
    // Check expiry
    const ttlMs = config.session.ttlMinutes * 60 * 1000;
    if (now - session.lastActivity > ttlMs) {
      session.tier = initialTier;
      session.requestHashes = [];
      session.strikeCount = 0;
    }
    
    session.lastActivity = now;
    
    // Never-downgrade
    let finalTier = initialTier;
    let escalated = false;
    
    if (config.session.neverDowngrade) {
      const tierOrder: Tier[] = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];
      const currentIndex = tierOrder.indexOf(session.tier);
      const newIndex = tierOrder.indexOf(initialTier);
      
      if (newIndex > currentIndex) {
        finalTier = initialTier;
        session.tier = initialTier;
        escalated = true;
      } else {
        finalTier = session.tier;
      }
    } else {
      finalTier = initialTier;
      session.tier = initialTier;
    }
    
    // Three-strike escalation
    if (config.session.threeStrikeEscalation) {
      const requestHash = this.hashRequest(messages);
      session.requestHashes.push(requestHash);
      session.requestHashes = session.requestHashes.slice(-10);
      
      const hashCounts = new Map<string, number>();
      for (const hash of session.requestHashes) {
        hashCounts.set(hash, (hashCounts.get(hash) || 0) + 1);
      }
      
      for (const count of hashCounts.values()) {
        if (count >= 3) {
          const tierOrder: Tier[] = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];
          const currentIndex = tierOrder.indexOf(finalTier);
          if (currentIndex < tierOrder.length - 1) {
            finalTier = tierOrder[currentIndex + 1];
            session.tier = finalTier;
            escalated = true;
            session.requestHashes = [];
          }
          break;
        }
      }
    }
    
    this.db.prepare('UPDATE sessions SET tier = ?, last_activity = ?, request_hashes = ?, strike_count = ? WHERE id = ?').run(session.tier, session.lastActivity, JSON.stringify(session.requestHashes), session.strikeCount, id);
    
    return { sessionId: id, tier: finalTier, escalated };
  }
  
  private cleanup(): void {
    const config = loadConfig();
    const ttlMs = config.session.ttlMinutes * 60 * 1000;
    const cutoff = Date.now() - ttlMs;
    this.db.prepare('DELETE FROM sessions WHERE last_activity < ?').run(cutoff);
  }
  
  private generateSessionId(messages: any[]): string {
    const firstUser = messages.find(m => m.role === 'user');
    const content = firstUser ? firstUser.content : Date.now().toString();
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
  
  private hashRequest(messages: any[]): string {
    return crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex');
  }
}
