export type Tier = 'SIMPLE' | 'MEDIUM' | 'COMPLEX' | 'REASONING';

export interface TierWeights {
  tokenCount: number;
  codePresence: number;
  reasoningMarkers: number;
  technicalTerms: number;
  creativeMarkers: number;
  simpleIndicators: number;
  multiStep: number;
  questionComplexity: number;
  imperativeVerbs: number;
  constraintIndicators: number;
  outputFormat: number;
  referenceComplexity: number;
  negationComplexity: number;
  domainSpecific: number;
}

export const DEFAULT_WEIGHTS: TierWeights = {
  tokenCount: 1.0,
  codePresence: 2.0,
  reasoningMarkers: 3.0,
  technicalTerms: 1.5,
  creativeMarkers: 1.2,
  simpleIndicators: -2.0,
  multiStep: 2.5,
  questionComplexity: 1.0,
  imperativeVerbs: 0.8,
  constraintIndicators: 1.5,
  outputFormat: 1.0,
  referenceComplexity: 1.3,
  negationComplexity: 1.2,
  domainSpecific: 1.8
};

export const KEYWORDS = {
  code: ['function', 'class', 'import', 'def', 'const', 'let', 'var', 'return', 'if', 'for', 'while', 'async', 'await', 'interface', 'type', 'struct', 'impl'],
  reasoning: ['prove', 'theorem', 'step by step', 'analyze', 'reasoning', 'logic', 'deduce', 'infer', 'conclude', 'therefore', 'because', 'explain why'],
  technical: ['algorithm', 'optimization', 'performance', 'architecture', 'database', 'api', 'protocol', 'encryption', 'authentication', 'deployment'],
  creative: ['creative', 'story', 'poem', 'imagine', 'brainstorm', 'design', 'artistic', 'narrative'],
  simple: ['hello', 'hi', 'thanks', 'thank you', 'yes', 'no', 'ok', 'sure', 'what is', 'who is'],
  multiStep: ['first', 'then', 'next', 'finally', 'step 1', 'step 2', 'after that', 'subsequently'],
  imperative: ['create', 'build', 'make', 'write', 'implement', 'develop', 'generate', 'produce'],
  constraint: ['must', 'should', 'require', 'need', 'ensure', 'constraint', 'limitation', 'restriction'],
  outputFormat: ['json', 'table', 'csv', 'markdown', 'yaml', 'xml', 'format', 'structure'],
  reference: ['according to', 'based on', 'referring to', 'as mentioned', 'from the', 'in the document'],
  negation: ['not', 'never', 'without', 'except', 'exclude', 'avoid', 'don\'t', 'cannot'],
  domain: ['medical', 'legal', 'financial', 'scientific', 'academic', 'research', 'clinical', 'regulatory']
};

export interface ModelConfig {
  name: string;
  tier: Tier;
  costPerMInput: number;
  costPerMOutput: number;
  capabilities: string[];
}

export const MODEL_CONFIGS: ModelConfig[] = [
  { name: 'google/gemini-3.1-flash-lite-preview', tier: 'SIMPLE', costPerMInput: 0.15, costPerMOutput: 0.15, capabilities: [] },
  { name: 'anthropic/claude-haiku-4.5', tier: 'MEDIUM', costPerMInput: 1.0, costPerMOutput: 5.0, capabilities: ['tools', 'vision'] },
  { name: 'anthropic/claude-sonnet-4.6', tier: 'COMPLEX', costPerMInput: 3.0, costPerMOutput: 15.0, capabilities: ['tools', 'vision'] },
  { name: 'anthropic/claude-opus-4.6', tier: 'REASONING', costPerMInput: 15.0, costPerMOutput: 75.0, capabilities: ['tools', 'vision'] }
];
