import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LogParser } from './parser';
import { ShadowDB, SessionAwareEntry } from './db';
import { Selector } from '../router/selector';
import { calculateCost } from './pricing';

const LOGS_DIR = path.join(os.homedir(), 'claw-proxy', 'logs-sync');

const TIER_ORDER = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];

function getTierRank(tier: string): number {
  return TIER_ORDER.indexOf(tier);
}

function getHigherTier(tier1: string, tier2: string): string {
  return getTierRank(tier1) >= getTierRank(tier2) ? tier1 : tier2;
}

function findJsonlFiles(dir: string): string[] {
  const files: string[] = [];
  
  if (!fs.existsSync(dir)) {
    console.log(`Logs directory not found: ${dir}`);
    return files;
  }

  function scan(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  scan(dir);
  return files;
}

function main() {
  console.log('Shadow Routing Analyzer');
  console.log('======================\n');

  const parser = new LogParser();
  const files = findJsonlFiles(LOGS_DIR);

  console.log(`Found ${files.length} JSONL files\n`);

  let totalProcessed = 0;
  for (const file of files) {
    const processed = parser.parseFile(file);
    if (processed > 0) {
      console.log(`${path.relative(LOGS_DIR, file)}: ${processed} entries`);
      totalProcessed += processed;
    }
  }

  parser.close();

  console.log(`\nProcessed ${totalProcessed} new entries`);
  console.log('\nRunning session-aware analysis...\n');

  const db = new ShadowDB();
  
  // Clear and rebuild session-aware table
  db.clearSessionAware();
  
  const entries = db.getAllEntries();
  const sessionMap = new Map<string, typeof entries>();
  
  // Group by session
  for (const entry of entries) {
    if (!sessionMap.has(entry.session_id)) {
      sessionMap.set(entry.session_id, []);
    }
    sessionMap.get(entry.session_id)!.push(entry);
  }

  const selector = new Selector();
  
  // Process each session with never-downgrade
  for (const [sessionId, sessionEntries] of sessionMap) {
    let peakTier = 'SIMPLE';
    
    for (const entry of sessionEntries) {
      peakTier = getHigherTier(peakTier, entry.routed_tier);
      
      const sessionSelection = selector.selectModel(peakTier as any, 'auto');
      const sessionCost = calculateCost(
        sessionSelection.model,
        entry.actual_input_tokens,
        entry.actual_output_tokens
      );

      const sessionAwareEntry: SessionAwareEntry = {
        timestamp: entry.timestamp,
        session_id: entry.session_id,
        agent: entry.agent,
        actual_model: entry.actual_model,
        actual_input_tokens: entry.actual_input_tokens,
        actual_output_tokens: entry.actual_output_tokens,
        actual_cost: entry.actual_cost,
        per_msg_tier: entry.routed_tier,
        per_msg_model: entry.routed_model,
        per_msg_cost: entry.routed_cost_estimate,
        session_tier: peakTier,
        session_model: sessionSelection.model,
        session_cost: sessionCost,
        savings_per_msg: entry.actual_cost - entry.routed_cost_estimate,
        savings_session: entry.actual_cost - sessionCost
      };

      db.insertSessionAware(sessionAwareEntry);
    }
  }

  const summary = db.getSummary();
  db.close();

  console.log('Per-message savings: $' + summary.per_message.savings.toFixed(4) + 
    ' (' + summary.per_message.savings_pct.toFixed(1) + '%)');
  console.log('Session-aware savings: $' + summary.session_aware.savings.toFixed(4) + 
    ' (' + summary.session_aware.savings_pct.toFixed(1) + '%)  ← realistic');
}

main();
