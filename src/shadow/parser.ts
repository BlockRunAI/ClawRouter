import * as fs from 'fs';
import * as path from 'path';
import { Scorer } from '../router/scorer';
import { Selector } from '../router/selector';
import { calculateCost } from './pricing';
import { ShadowDB, ShadowEntry } from './db';

interface LogEntry {
  type: string;
  timestamp?: string;
  id?: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
    model?: string;
    usage?: {
      input?: number;
      output?: number;
      cost?: {
        total?: number;
      };
    };
  };
  model?: string;
}

export class LogParser {
  private scorer = new Scorer();
  private selector = new Selector();
  private db = new ShadowDB();

  private sanitizeMessage(content: string): string {
    return content
      .replace(/^.*?\(untrusted (?:metadata|context)\):[\s\S]*?```json[\s\S]*?```/gm, '')
      .replace(/^Replied message \(untrusted, for context\):.*$/gm, '')
      .replace(/^System: \[.*?\].*$/gm, '')
      .trim();
  }

  parseFile(filePath: string): number {
    const lastLine = this.db.getLastProcessedLine(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    
    if (lines.length <= lastLine) return 0;

    const entries: LogEntry[] = [];
    for (let i = lastLine; i < lines.length; i++) {
      try {
        entries.push(JSON.parse(lines[i]));
      } catch {}
    }

    let processed = 0;
    const agentName = this.extractAgentName(filePath);
    const sessionId = this.extractSessionId(filePath);

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.type === 'message' && entry.message?.role === 'assistant' && entry.message?.usage) {
        const userMsg = this.findPrecedingUserMessage(entries, i);
        if (userMsg) {
          this.processAssistantResponse(entry, userMsg, agentName, sessionId);
          processed++;
        }
      }
    }

    this.db.updateSyncState(filePath, lines.length);
    return processed;
  }

  private findPrecedingUserMessage(entries: LogEntry[], currentIndex: number): string | null {
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (entries[i].type === 'message' && entries[i].message?.role === 'user') {
        const content = entries[i].message!.content;
        if (Array.isArray(content)) {
          const textItem = content.find(item => item.type === 'text');
          return textItem?.text || null;
        }
        return content;
      }
    }
    return null;
  }

  private processAssistantResponse(entry: LogEntry, userContent: string, agent: string, sessionId: string) {
    const actualModel = entry.message?.model || entry.model || 'unknown';
    const inputTokens = entry.message?.usage?.input || 0;
    const outputTokens = entry.message?.usage?.output || 0;
    const actualCost = entry.message?.usage?.cost?.total || calculateCost(actualModel, inputTokens, outputTokens);

    const sanitized = this.sanitizeMessage(userContent);
    const scoringResult = this.scorer.score([{ role: 'user', content: sanitized }]);
    const selection = this.selector.selectModel(scoringResult.tier, 'auto');
    const routedCost = calculateCost(selection.model, inputTokens, outputTokens);

    const shadowEntry: ShadowEntry = {
      timestamp: entry.timestamp || new Date().toISOString(),
      session_id: sessionId,
      agent,
      actual_model: actualModel,
      actual_input_tokens: inputTokens,
      actual_output_tokens: outputTokens,
      actual_cost: actualCost,
      routed_tier: scoringResult.tier,
      routed_model: selection.model,
      routed_cost_estimate: routedCost,
      savings: actualCost - routedCost,
      confidence: scoringResult.confidence
    };

    this.db.insert(shadowEntry);
  }

  private extractAgentName(filePath: string): string {
    const match = filePath.match(/agents\/([^\/]+)\//);
    return match ? match[1] : 'unknown';
  }

  private extractSessionId(filePath: string): string {
    const basename = path.basename(filePath, '.jsonl');
    return basename;
  }

  close() {
    this.db.close();
  }
}
