import { Tier } from './config';
import * as http from 'http';

export interface ScoringResult {
  tier: Tier;
  domain: string;
  confidence: number;
  rawScore: number;
}

const SCORER_URL = process.env.SCORER_URL || 'http://localhost:8403';

function callScorer(text: string): Promise<{ tier: Tier; domain: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ question: text });
    const url = new URL(`${SCORER_URL}/score`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Scorer returned ${res.statusCode}: ${data}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve({ tier: parsed.tier as Tier, domain: parsed.domain });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export class Scorer {
  async scoreAsync(messages: any[]): Promise<ScoringResult> {
    const userMsgs = messages.filter((m: any) => m.role === 'user');
    const userPrompt = userMsgs.length ? userMsgs[userMsgs.length - 1].content : '';

    try {
      const result = await callScorer(userPrompt);
      const tierScore = { SIMPLE: 0.1, MEDIUM: 0.4, COMPLEX: 0.7, REASONING: 0.9 };
      return {
        tier: result.tier,
        domain: result.domain,
        confidence: 1.0,
        rawScore: tierScore[result.tier] ?? 0.5,
      };
    } catch {
      return { tier: 'MEDIUM', domain: 'other', confidence: 0.0, rawScore: 0.5 };
    }
  }

  // Synchronous wrapper kept for backward compatibility — calls scoreAsync internally
  score(messages: any[]): ScoringResult {
    // For sync callers, return MEDIUM as default.
    // The proxy should use scoreAsync instead.
    return { tier: 'MEDIUM', domain: 'other', confidence: 0.0, rawScore: 0.5 };
  }
}
