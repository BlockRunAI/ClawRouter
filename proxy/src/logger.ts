import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from './config';

interface LogEntry {
  timestamp: string;
  session_id: string;
  tier: string;
  domain: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  cost_estimate: number;
  compressed_savings: number;
}

export class Logger {
  private logDir: string;
  
  constructor() {
    const config = loadConfig();
    this.logDir = config.logging.dir;
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }
  
  log(entry: LogEntry): void {
    const config = loadConfig();
    if (!config.logging.enabled) return;
    
    const date = new Date().toISOString().split('T')[0];
    const logFile = path.join(this.logDir, `${date}.jsonl`);
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(logFile, line);
  }

  getStats(days: number = 7): any {
    const files = fs.readdirSync(this.logDir).filter(f => f.endsWith('.jsonl')).sort().reverse();
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const entries: LogEntry[] = [];

    for (const file of files) {
      if (file.replace('.jsonl', '') < cutoff.split('T')[0]) break;
      const lines = fs.readFileSync(path.join(this.logDir, file), 'utf8').trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        try { entries.push(JSON.parse(line)); } catch {}
      }
    }

    const latencies = entries.map(e => e.latency_ms).sort((a, b) => a - b);
    const byTier: Record<string, number> = {};
    const byDomain: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    const sessions = new Set<string>();
    let totalCost = 0, totalIn = 0, totalOut = 0, totalSavings = 0;

    for (const e of entries) {
      byTier[e.tier] = (byTier[e.tier] || 0) + 1;
      byDomain[e.domain || 'unknown'] = (byDomain[e.domain || 'unknown'] || 0) + 1;
      byModel[e.model] = (byModel[e.model] || 0) + 1;
      sessions.add(e.session_id);
      totalCost += e.cost_estimate || 0;
      totalIn += e.input_tokens || 0;
      totalOut += e.output_tokens || 0;
      totalSavings += e.compressed_savings || 0;
    }

    const pct = (i: number) => latencies.length ? latencies[Math.min(Math.floor(latencies.length * i), latencies.length - 1)] : 0;

    return {
      period_days: days,
      total_requests: entries.length,
      unique_sessions: sessions.size,
      latency: { avg: Math.round(latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1)), p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
      by_tier: byTier,
      by_domain: byDomain,
      by_model: byModel,
      tokens: { total_input: totalIn, total_output: totalOut },
      total_cost_estimate: Math.round(totalCost * 1e6) / 1e6,
      compression: { total_savings_chars: totalSavings, avg_savings: entries.length ? Math.round(totalSavings / entries.length) : 0 }
    };
  }
}
