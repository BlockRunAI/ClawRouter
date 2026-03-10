import { Tier, MODEL_CONFIGS } from './config';
import { loadConfig } from '../config';

export interface ModelSelection {
  model: string;
  fallbacks: string[];
}

export class Selector {
  selectModel(tier: Tier, profile: string, capabilities?: string[]): ModelSelection {
    const config = loadConfig();
    const profileConfig = config.routing.profiles[profile];
    
    if (!profileConfig) {
      throw new Error(`Unknown profile: ${profile}`);
    }
    
    const primaryModel = profileConfig[tier];
    if (!primaryModel) {
      throw new Error(`No model configured for tier ${tier} in profile ${profile}`);
    }
    
    // Build fallback chain
    const fallbacks: string[] = [];
    const tiers: Tier[] = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];
    const currentIndex = tiers.indexOf(tier);
    
    // Add higher tiers as fallbacks
    for (let i = currentIndex + 1; i < tiers.length; i++) {
      const fallbackModel = profileConfig[tiers[i]];
      if (fallbackModel && fallbackModel !== primaryModel) {
        fallbacks.push(fallbackModel);
      }
    }
    
    // Limit to 3 fallbacks
    return {
      model: primaryModel,
      fallbacks: fallbacks.slice(0, 3)
    };
  }
  
  getModelInfo(modelName: string) {
    return MODEL_CONFIGS.find(m => m.name === modelName);
  }
}
