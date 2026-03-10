import * as https from 'https';
import * as http from 'http';
import { loadConfig } from './config';

export interface UpstreamResponse {
  statusCode: number;
  headers: any;
  body?: any;
  stream?: NodeJS.ReadableStream;
}

export class Upstream {
  private modelCooldowns: Map<string, number> = new Map();
  
  async request(model: string, body: any, stream: boolean): Promise<UpstreamResponse> {
    // Check cooldown
    const cooldown = this.modelCooldowns.get(model);
    if (cooldown && Date.now() < cooldown) {
      throw new Error(`Model ${model} is on cooldown until ${new Date(cooldown).toISOString()}`);
    }
    
    const isOllama = model.startsWith('ollama/');
    const config = loadConfig();
    
    if (isOllama) {
      return this.requestOllama(model.replace('ollama/', ''), body, stream);
    } else {
      const cleanModel = model.replace(/^openrouter\//, '');
      console.log(`[route] model=${cleanModel} stream=${stream}`);
      return this.requestOpenRouter(cleanModel, body, stream);
    }
  }
  
  private async requestOpenRouter(model: string, body: any, stream: boolean): Promise<UpstreamResponse> {
    const config = loadConfig();
    const baseUrl = config.upstream.openrouter.baseUrl.replace(/\/$/, '');
    const url = new URL(baseUrl + '/chat/completions');
    
    const payload = {
      ...body,
      model,
      stream
    };
    
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.upstream.openrouter.apiKey}`,
          'HTTP-Referer': 'https://github.com/claw-proxy',
          'X-Title': 'claw-proxy'
        }
      }, (res) => {
        if (res.statusCode === 429) {
          this.modelCooldowns.set(model, Date.now() + 60000);
          reject(new Error('Rate limited'));
          return;
        }
        
        if (stream) {
          resolve({
            statusCode: res.statusCode!,
            headers: res.headers,
            stream: res
          });
        } else {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve({
                statusCode: res.statusCode!,
                headers: res.headers,
                body: JSON.parse(data)
              });
            } catch (e) {
              reject(e);
            }
          });
        }
      });
      
      req.on('error', reject);
      req.setTimeout(120000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      req.write(JSON.stringify(payload));
      req.end();
    });
  }
  
  private async requestOllama(model: string, body: any, stream: boolean): Promise<UpstreamResponse> {
    const config = loadConfig();
    if (!config.upstream.ollama.enabled) {
      throw new Error('Ollama is disabled');
    }
    
    const baseUrl = config.upstream.ollama.baseUrl.replace(/\/$/, '');
    const url = new URL(baseUrl + '/chat/completions');
    
    const payload = {
      ...body,
      model,
      stream
    };
    
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 11434,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      }, (res) => {
        if (stream) {
          resolve({
            statusCode: res.statusCode!,
            headers: res.headers,
            stream: res
          });
        } else {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve({
                statusCode: res.statusCode!,
                headers: res.headers,
                body: JSON.parse(data)
              });
            } catch (e) {
              reject(e);
            }
          });
        }
      });
      
      req.on('error', reject);
      req.setTimeout(120000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      req.write(JSON.stringify(payload));
      req.end();
    });
  }
}
