import * as http from 'http';
import { ProxyHandler } from './proxy';
import { loadConfig, logActiveConfig } from './config';
import { ShadowDB } from './shadow/db';

const proxy = new ProxyHandler();

const server = http.createServer(async (req, res) => {
  const url = req.url || '';
  
  try {
    // Auth check (skip health endpoint)
    const cfg = loadConfig();
    if (cfg.apiKeys.length > 0 && url !== '/health') {
      const auth = req.headers['authorization'];
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token || !cfg.apiKeys.includes(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key', type: 'authentication_error' } }));
        return;
      }
    }

    if (req.method === 'GET' && url === '/') {
      const pkg = require('../package.json');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: 'claw-proxy',
        version: pkg.version,
        endpoints: [
          'POST /v1/chat/completions',
          'POST /v1/completions',
          'POST /v1/embeddings',
          'POST /v1/responses',
          'POST /v1/audio/speech',
          'POST /v1/audio/transcriptions',
          'POST /v1/images/generations',
          'GET /v1/models',
          'GET /health',
          'GET /stats'
        ]
      }));
    } else if (req.method === 'POST' && url === '/v1/chat/completions') {
      await proxy.handleChatCompletion(req, res);
    } else if (req.method === 'POST' && url === '/v1/completions') {
      await proxy.handlePassthrough(req, res, '/completions');
    } else if (req.method === 'POST' && url === '/v1/embeddings') {
      await proxy.handlePassthrough(req, res, '/embeddings');
    } else if (req.method === 'POST' && url === '/v1/responses') {
      await proxy.handlePassthrough(req, res, '/responses');
    } else if (req.method === 'POST' && url === '/v1/audio/speech') {
      await proxy.handlePassthrough(req, res, '/audio/speech');
    } else if (req.method === 'POST' && url === '/v1/audio/transcriptions') {
      await proxy.handlePassthrough(req, res, '/audio/transcriptions');
    } else if (req.method === 'POST' && url === '/v1/images/generations') {
      await proxy.handlePassthrough(req, res, '/images/generations');
    } else if (req.method === 'GET' && url === '/v1/models') {
      await proxy.handleModels(req, res);
    } else if (req.method === 'GET' && url === '/health') {
      await proxy.handleHealth(req, res);
    } else if (req.method === 'GET' && url.startsWith('/stats')) {
      await proxy.handleStats(req, res);
    } else if (req.method === 'GET' && url === '/shadow') {
      const db = new ShadowDB();
      const summary = db.getSummary();
      db.close();
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(summary, null, 2));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (err) {
    console.error('Request error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
});

const config = loadConfig();
logActiveConfig(config);
server.listen(config.port, config.host, () => {
  console.log(`claw-proxy listening on ${config.host}:${config.port}`);
});
