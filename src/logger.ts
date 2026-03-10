import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from './config';

interface LogEntry {
  timestamp: string;
  session_id: string;
  tier: string;
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
}
