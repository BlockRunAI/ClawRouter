import { IncomingMessage, ServerResponse } from 'http';
import * as https from 'https';
import { Scorer } from './router/scorer';
import { Selector } from './router/selector';
import { CompressionPipeline } from './compression/pipeline';
import { SessionManager } from './session';
import { Cache } from './cache';
import { Upstream } from './upstream';
import { Logger } from './logger';
import { loadConfig } from './config';
import { Tier } from './router/config';

export class ProxyHandler {
  private scorer = new Scorer();
  private selector = new Selector();
  private compression = new CompressionPipeline();
  private sessions = new SessionManager();
  private cache = new Cache();
  private upstream = new Upstream();
  private logger = new Logger();
  
  async handleChatCompletion(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();
    let body = '';
    
    for await (const chunk of req) {
      body += chunk;
    }
    
    const requestBody = JSON.parse(body);
    const { messages, model, stream = false } = requestBody;
    
    // Check request dedup
    const dedupCheck = this.cache.checkDedup(requestBody);
    if (dedupCheck.isDuplicate && dedupCheck.promise) {
      const cached = await dedupCheck.promise;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cached));
      return;
    }
    
    // Determine routing
    let selectedModel = model;
    let tier: Tier = 'MEDIUM';
    
    if (model === 'auto' || model === 'eco' || model === 'premium') {
      const scoringResult = await this.scorer.scoreAsync(messages);
      const config = loadConfig();
      
      if (scoringResult.confidence < config.routing.confidenceThreshold) {
        tier = config.routing.defaultTier as Tier;
      } else {
        tier = scoringResult.tier;
      }
      
      const domain = scoringResult.domain || 'other';
      const profile = config.routing.profiles[domain] ? domain : 'other';
      
      const sessionId = req.headers['x-session-id'] as string | undefined;
      const sessionResult = this.sessions.getOrCreate(sessionId, messages, tier);
      tier = sessionResult.tier;
      
      const selection = this.selector.selectModel(tier, profile);
      selectedModel = selection.model;
      
      // Try with fallbacks
      let lastError: Error | null = null;
      const modelsToTry = [selectedModel, ...selection.fallbacks];
      
      for (const tryModel of modelsToTry) {
        try {
          const result = await this.executeRequest(tryModel, requestBody, stream, res, startTime, sessionResult.sessionId, tier);
          return;
        } catch (err) {
          lastError = err as Error;
          continue;
        }
      }
      
      throw lastError || new Error('All models failed');
    } else {
      // Direct model passthrough
      await this.executeRequest(selectedModel, requestBody, stream, res, startTime, 'direct', 'MEDIUM');
    }
  }
  
  private async executeRequest(
    model: string, 
    requestBody: any, 
    stream: boolean, 
    res: ServerResponse,
    startTime: number,
    sessionId: string,
    tier: Tier
  ): Promise<void> {
    // Check response cache
    const cached = this.cache.getCachedResponse(model, requestBody.messages);
    if (cached && !stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cached));
      return;
    }
    
    // Compress
    const { compressed, savings } = this.compression.compress(requestBody.messages);
    const compressedBody = { ...requestBody, messages: compressed };
    
    // Make upstream request
    const upstreamRes = await this.upstream.request(model, compressedBody, stream);
    
    if (stream) {
      res.writeHead(upstreamRes.statusCode, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      
      upstreamRes.stream!.pipe(res);
      
      upstreamRes.stream!.on('end', () => {
        const latency = Date.now() - startTime;
        this.logger.log({
          timestamp: new Date().toISOString(),
          session_id: sessionId,
          tier,
          model,
          input_tokens: this.estimateTokens(compressed),
          output_tokens: 0,
          latency_ms: latency,
          cost_estimate: 0,
          compressed_savings: savings
        });
      });
    } else {
      const responseBody = upstreamRes.body;
      
      // Cache response
      this.cache.setCachedResponse(model, requestBody.messages, responseBody);
      
      // Log
      const latency = Date.now() - startTime;
      const inputTokens = responseBody.usage?.prompt_tokens || this.estimateTokens(compressed);
      const outputTokens = responseBody.usage?.completion_tokens || 0;
      const modelInfo = this.selector.getModelInfo(model);
      const cost = modelInfo 
        ? (inputTokens / 1000000 * modelInfo.costPerMInput) + (outputTokens / 1000000 * modelInfo.costPerMOutput)
        : 0;
      
      this.logger.log({
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        tier,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        latency_ms: latency,
        cost_estimate: cost,
        compressed_savings: savings
      });
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    }
  }
  
  private estimateTokens(messages: any[]): number {
    return Math.ceil(JSON.stringify(messages).length / 4);
  }
  
  async handleModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const config = loadConfig();
    const models: any[] = [];
    
    for (const [profile, tiers] of Object.entries(config.routing.profiles)) {
      for (const [tier, model] of Object.entries(tiers)) {
        if (!models.find(m => m.id === model)) {
          models.push({
            id: model,
            object: 'model',
            created: Date.now(),
            owned_by: 'claw-proxy'
          });
        }
      }
    }
    
    // Add profile shortcuts
    models.push({ id: 'auto', object: 'model', created: Date.now(), owned_by: 'claw-proxy' });
    models.push({ id: 'eco', object: 'model', created: Date.now(), owned_by: 'claw-proxy' });
    models.push({ id: 'premium', object: 'model', created: Date.now(), owned_by: 'claw-proxy' });
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: models }));
  }
  
  async handleHealth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
  }
  
  async handleStats(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: 'Stats endpoint - implementation requires log parsing'
    }));
  }
  
  async handlePassthrough(req: IncomingMessage, res: ServerResponse, endpoint: string): Promise<void> {
    const config = loadConfig();
    const baseUrl = config.upstream.openrouter.baseUrl.replace(/\/$/, '');
    const url = new URL(baseUrl + endpoint);
    
    return new Promise((resolve, reject) => {
      const isMultipart = req.headers['content-type']?.includes('multipart/form-data');
      
      const proxyReq = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: req.method,
        headers: {
          ...req.headers,
          'Authorization': `Bearer ${config.upstream.openrouter.apiKey}`,
          'HTTP-Referer': 'https://github.com/claw-proxy',
          'X-Title': 'claw-proxy',
          host: url.hostname
        }
      }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode!, upstreamRes.headers);
        upstreamRes.pipe(res);
        upstreamRes.on('end', resolve);
      });
      
      proxyReq.on('error', reject);
      req.pipe(proxyReq);
    });
  }
}
