import { Tier, DEFAULT_WEIGHTS, KEYWORDS, TierWeights } from './config';

export interface ScoringResult {
  tier: Tier;
  confidence: number;
  rawScore: number;
}

export class Scorer {
  private weights: TierWeights;
  
  constructor(weights: TierWeights = DEFAULT_WEIGHTS) {
    this.weights = weights;
  }
  
  private sanitizeMessage(content: string): string {
    return content
      .replace(/^.*?\(untrusted (?:metadata|context)\):[\s\S]*?```json[\s\S]*?```/gm, '')
      .replace(/^Replied message \(untrusted, for context\):.*$/gm, '')
      .replace(/^System: \[.*?\].*$/gm, '')
      .trim();
  }
  
  score(messages: any[]): ScoringResult {
    const userPrompt = messages.filter(m => m.role === 'user').map(m => m.content).join(' ');
    const sanitized = this.sanitizeMessage(userPrompt);
    const text = sanitized.toLowerCase();
    
    // Direct override: 2+ reasoning keywords → REASONING
    const reasoningCount = this.countMatches(text, KEYWORDS.reasoning);
    if (reasoningCount >= 2) {
      return { tier: 'REASONING', confidence: 1.0, rawScore: 100 };
    }
    
    let score = 0;
    
    // 1. Token count
    const tokens = this.estimateTokens(sanitized);
    if (tokens < 50) score += this.weights.tokenCount * 0;
    else if (tokens < 200) score += this.weights.tokenCount * 1;
    else if (tokens < 500) score += this.weights.tokenCount * 2;
    else score += this.weights.tokenCount * 3;
    
    // 2. Code presence
    score += this.weights.codePresence * this.countMatches(text, KEYWORDS.code);
    
    // 3. Reasoning markers
    score += this.weights.reasoningMarkers * reasoningCount;
    
    // 4. Technical terms
    score += this.weights.technicalTerms * this.countMatches(text, KEYWORDS.technical);
    
    // 5. Creative markers
    score += this.weights.creativeMarkers * this.countMatches(text, KEYWORDS.creative);
    
    // 6. Simple indicators (NEGATIVE)
    score += this.weights.simpleIndicators * this.countMatches(text, KEYWORDS.simple);
    
    // 7. Multi-step patterns
    score += this.weights.multiStep * this.countMatches(text, KEYWORDS.multiStep);
    
    // 8. Question complexity
    const questionMarks = (text.match(/\?/g) || []).length;
    score += this.weights.questionComplexity * Math.min(questionMarks, 3);
    
    // 9. Imperative verbs
    score += this.weights.imperativeVerbs * this.countMatches(text, KEYWORDS.imperative);
    
    // 10. Constraint indicators
    score += this.weights.constraintIndicators * this.countMatches(text, KEYWORDS.constraint);
    
    // 11. Output format keywords
    score += this.weights.outputFormat * this.countMatches(text, KEYWORDS.outputFormat);
    
    // 12. Reference complexity
    score += this.weights.referenceComplexity * this.countMatches(text, KEYWORDS.reference);
    
    // 13. Negation complexity
    score += this.weights.negationComplexity * this.countMatches(text, KEYWORDS.negation);
    
    // 14. Domain-specific keywords
    score += this.weights.domainSpecific * this.countMatches(text, KEYWORDS.domain);
    
    const tier = this.scoreToTier(score);
    const confidence = this.sigmoid(score);
    
    return { tier, confidence, rawScore: score };
  }
  
  private countMatches(text: string, keywords: string[]): number {
    return keywords.reduce((count, kw) => count + (text.includes(kw) ? 1 : 0), 0);
  }
  
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
  
  private scoreToTier(score: number): Tier {
    if (score < 5) return 'SIMPLE';
    if (score < 15) return 'MEDIUM';
    if (score < 30) return 'COMPLEX';
    return 'REASONING';
  }
  
  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x / 10));
  }
}
