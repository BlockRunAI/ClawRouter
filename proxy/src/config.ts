import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface Config {
  port: number;
  host: string;
  upstream: {
    openrouter: {
      baseUrl: string;
      apiKey: string;
    };
    ollama: {
      baseUrl: string;
      enabled: boolean;
    };
  };
  routing: {
    defaultTier: string;
    confidenceThreshold: number;
    profiles: {
      [profile: string]: {
        [tier: string]: string;
      };
    };
  };
  compression: {
    enabled: boolean;
    layers: string[];
  };
  session: {
    ttlMinutes: number;
    neverDowngrade: boolean;
    threeStrikeEscalation: boolean;
  };
  cache: {
    enabled: boolean;
    maxEntries: number;
    ttlSeconds: number;
  };
  logging: {
    dir: string;
    enabled: boolean;
  };
}

let config: Config | null = null;

function loadDotEnv(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
    }
  }
}

export function loadConfig(): Config {
  if (config) return config;
  
  loadDotEnv();
  const configPath = path.join(process.cwd(), 'config.yaml');
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = yaml.load(raw) as Config;
  
  // Recursively expand ${VAR} in all string values
  deepExpandEnv(parsed);
  
  // Expand tilde in logging dir
  parsed.logging.dir = expandTilde(parsed.logging.dir);
  
  // Apply environment variable overrides
  applyEnvOverrides(parsed);
  
  config = parsed;
  return config;
}

function deepExpandEnv(obj: any): void {
  if (typeof obj === 'string') return;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      if (typeof item === 'string') {
        obj[i] = expandEnv(item);
      } else if (typeof item === 'object' && item !== null) {
        deepExpandEnv(item);
      }
    });
  } else if (typeof obj === 'object' && obj !== null) {
    for (const key in obj) {
      if (typeof obj[key] === 'string') {
        obj[key] = expandEnv(obj[key]);
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        deepExpandEnv(obj[key]);
      }
    }
  }
}

function expandEnv(str: string): string {
  return str.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] || '');
}

function expandTilde(str: string): string {
  if (str.startsWith('~/')) {
    return path.join(process.env.HOME || '', str.slice(2));
  }
  return str;
}

function applyEnvOverrides(cfg: Config): void {
  // Server
  if (process.env.CLAW_PROXY_PORT) cfg.port = parseInt(process.env.CLAW_PROXY_PORT, 10);
  if (process.env.CLAW_PROXY_HOST) cfg.host = process.env.CLAW_PROXY_HOST;
  
  // Upstream
  if (process.env.OPENROUTER_API_KEY) cfg.upstream.openrouter.apiKey = process.env.OPENROUTER_API_KEY;
  if (process.env.OPENROUTER_BASE_URL) cfg.upstream.openrouter.baseUrl = process.env.OPENROUTER_BASE_URL;
  if (process.env.OLLAMA_BASE_URL) cfg.upstream.ollama.baseUrl = process.env.OLLAMA_BASE_URL;
  if (process.env.OLLAMA_ENABLED) cfg.upstream.ollama.enabled = process.env.OLLAMA_ENABLED === 'true';
  
  // Routing
  if (process.env.CLAW_PROXY_DEFAULT_TIER) cfg.routing.defaultTier = process.env.CLAW_PROXY_DEFAULT_TIER;
  if (process.env.CLAW_PROXY_CONFIDENCE_THRESHOLD) cfg.routing.confidenceThreshold = parseFloat(process.env.CLAW_PROXY_CONFIDENCE_THRESHOLD);
  
  // Model assignments - auto profile
  if (process.env.CLAW_PROXY_AUTO_SIMPLE) cfg.routing.profiles.auto.SIMPLE = process.env.CLAW_PROXY_AUTO_SIMPLE;
  if (process.env.CLAW_PROXY_AUTO_MEDIUM) cfg.routing.profiles.auto.MEDIUM = process.env.CLAW_PROXY_AUTO_MEDIUM;
  if (process.env.CLAW_PROXY_AUTO_COMPLEX) cfg.routing.profiles.auto.COMPLEX = process.env.CLAW_PROXY_AUTO_COMPLEX;
  if (process.env.CLAW_PROXY_AUTO_REASONING) cfg.routing.profiles.auto.REASONING = process.env.CLAW_PROXY_AUTO_REASONING;
  
  // Model assignments - eco profile
  if (process.env.CLAW_PROXY_ECO_SIMPLE) cfg.routing.profiles.eco.SIMPLE = process.env.CLAW_PROXY_ECO_SIMPLE;
  if (process.env.CLAW_PROXY_ECO_MEDIUM) cfg.routing.profiles.eco.MEDIUM = process.env.CLAW_PROXY_ECO_MEDIUM;
  if (process.env.CLAW_PROXY_ECO_COMPLEX) cfg.routing.profiles.eco.COMPLEX = process.env.CLAW_PROXY_ECO_COMPLEX;
  if (process.env.CLAW_PROXY_ECO_REASONING) cfg.routing.profiles.eco.REASONING = process.env.CLAW_PROXY_ECO_REASONING;
  
  // Model assignments - premium profile
  if (process.env.CLAW_PROXY_PREMIUM_SIMPLE) cfg.routing.profiles.premium.SIMPLE = process.env.CLAW_PROXY_PREMIUM_SIMPLE;
  if (process.env.CLAW_PROXY_PREMIUM_MEDIUM) cfg.routing.profiles.premium.MEDIUM = process.env.CLAW_PROXY_PREMIUM_MEDIUM;
  if (process.env.CLAW_PROXY_PREMIUM_COMPLEX) cfg.routing.profiles.premium.COMPLEX = process.env.CLAW_PROXY_PREMIUM_COMPLEX;
  if (process.env.CLAW_PROXY_PREMIUM_REASONING) cfg.routing.profiles.premium.REASONING = process.env.CLAW_PROXY_PREMIUM_REASONING;
  
  // Session
  if (process.env.CLAW_PROXY_SESSION_TTL) cfg.session.ttlMinutes = parseInt(process.env.CLAW_PROXY_SESSION_TTL, 10);
  
  // Cache
  if (process.env.CLAW_PROXY_CACHE_ENABLED) cfg.cache.enabled = process.env.CLAW_PROXY_CACHE_ENABLED === 'true';
  if (process.env.CLAW_PROXY_CACHE_MAX_ENTRIES) cfg.cache.maxEntries = parseInt(process.env.CLAW_PROXY_CACHE_MAX_ENTRIES, 10);
  if (process.env.CLAW_PROXY_CACHE_TTL) cfg.cache.ttlSeconds = parseInt(process.env.CLAW_PROXY_CACHE_TTL, 10);
  
  // Logging
  if (process.env.CLAW_PROXY_LOG_DIR) cfg.logging.dir = expandTilde(process.env.CLAW_PROXY_LOG_DIR);
  if (process.env.CLAW_PROXY_LOG_ENABLED) cfg.logging.enabled = process.env.CLAW_PROXY_LOG_ENABLED === 'true';
}

function maskApiKey(key: string): string {
  if (!key || key.length < 8) return '***';
  return key.slice(0, 7) + '...' + key.slice(-4);
}

export function logActiveConfig(cfg: Config): void {
  console.log('Active configuration:');
  console.log(JSON.stringify({
    ...cfg,
    upstream: {
      ...cfg.upstream,
      openrouter: {
        ...cfg.upstream.openrouter,
        apiKey: maskApiKey(cfg.upstream.openrouter.apiKey)
      }
    }
  }, null, 2));
}
