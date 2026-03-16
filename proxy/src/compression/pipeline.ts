import { Message, dedupMessages } from './dedup';
import { normalizeWhitespace } from './whitespace';
import { compactJson } from './json-compact';
import { minifyCodeBlocks } from './code-minify';
import { compressToolResults } from './tool-result-compress';
import { loadConfig } from '../config';

export class CompressionPipeline {
  private layers: Map<string, (msgs: Message[]) => Message[]>;
  
  constructor() {
    this.layers = new Map([
      ['dedup', dedupMessages],
      ['whitespace', normalizeWhitespace],
      ['json-compact', compactJson],
      ['code-minify', minifyCodeBlocks],
      ['tool-result-compress', compressToolResults]
    ]);
  }
  
  compress(messages: Message[]): { compressed: Message[], savings: number } {
    const config = loadConfig();
    if (!config.compression.enabled) {
      return { compressed: messages, savings: 0 };
    }
    
    const originalSize = this.estimateSize(messages);
    let result = messages;
    
    for (const layerName of config.compression.layers) {
      const layer = this.layers.get(layerName);
      if (layer) {
        result = layer(result);
      }
    }
    
    const compressedSize = this.estimateSize(result);
    const savings = originalSize - compressedSize;
    
    return { compressed: result, savings };
  }
  
  private estimateSize(messages: Message[]): number {
    return JSON.stringify(messages).length;
  }
}
