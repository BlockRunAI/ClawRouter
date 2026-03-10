import * as crypto from 'crypto';
import { loadConfig } from './config';

interface CacheEntry {
  response: any;
  timestamp: number;
}

interface DedupEntry {
  timestamp: number;
  inFlight: boolean;
  promise?: Promise<any>;
}

export class Cache {
  private responseCache: Map<string, CacheEntry> = new Map();
  private requestDedup: Map<string, DedupEntry> = new Map();
  private accessOrder: string[] = [];
  
  getCachedResponse(model: string, messages: any[]): any | null {
    const config = loadConfig();
    if (!config.cache.enabled) return null;
    
    const key = this.cacheKey(model, messages);
    const entry = this.responseCache.get(key);
    
    if (!entry) return null;
    
    const now = Date.now();
    const ttlMs = config.cache.ttlSeconds * 1000;
    
    if (now - entry.timestamp > ttlMs) {
      this.responseCache.delete(key);
      return null;
    }
    
    // Update LRU
    this.accessOrder = this.accessOrder.filter(k => k !== key);
    this.accessOrder.push(key);
    
    return entry.response;
  }
  
  setCachedResponse(model: string, messages: any[], response: any): void {
    const config = loadConfig();
    if (!config.cache.enabled) return;
    
    const key = this.cacheKey(model, messages);
    
    // LRU eviction
    if (this.responseCache.size >= config.cache.maxEntries) {
      const oldest = this.accessOrder.shift();
      if (oldest) this.responseCache.delete(oldest);
    }
    
    this.responseCache.set(key, {
      response,
      timestamp: Date.now()
    });
    this.accessOrder.push(key);
  }
  
  checkDedup(body: any): { isDuplicate: boolean, promise?: Promise<any> } {
    const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const entry = this.requestDedup.get(hash);
    
    if (!entry) {
      this.requestDedup.set(hash, { timestamp: Date.now(), inFlight: true });
      setTimeout(() => this.requestDedup.delete(hash), 30000);
      return { isDuplicate: false };
    }
    
    const now = Date.now();
    if (now - entry.timestamp > 30000) {
      this.requestDedup.delete(hash);
      this.requestDedup.set(hash, { timestamp: now, inFlight: true });
      return { isDuplicate: false };
    }
    
    return { isDuplicate: true, promise: entry.promise };
  }
  
  setDedupPromise(body: any, promise: Promise<any>): void {
    const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const entry = this.requestDedup.get(hash);
    if (entry) {
      entry.promise = promise;
    }
  }
  
  private cacheKey(model: string, messages: any[]): string {
    const msgHash = crypto.createHash('sha256')
      .update(JSON.stringify(messages.filter(m => m.role !== 'system')))
      .digest('hex');
    return `${model}:${msgHash}`;
  }
}
