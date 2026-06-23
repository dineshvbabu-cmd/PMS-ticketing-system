const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const PORT = process.env.PORT || 3000;

// These come from Railway environment variables
const ENV_CONFIG = {
  TENANT_ID:   process.env.AZURE_TENANT_ID   || '',
  CLIENT_ID:   process.env.AZURE_CLIENT_ID   || '',
  ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY || '',
  APP_URL:     process.env.RAILWAY_STATIC_URL
               ? 'https://' + process.env.RAILWAY_STATIC_URL
               : (process.env.APP_URL || 'http://localhost:' + PORT),
};

// Read the HTML template once
let htmlTemplate = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');

// Inject env vars into the HTML as a <script> block before </head>
function buildHtml(req) {
  const host    = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto   = req.headers['x-forwarded-proto'] || 'https';
  const appUrl  = host ? proto + '://' + host : ENV_CONFIG.APP_URL;
  const config  = `
<script>
  // Injected by server — do not edit manually
  window.__PMS_CONFIG = {
    TENANT_ID:    "${ENV_CONFIG.TENANT_ID}",
    CLIENT_ID:    "${ENV_CONFIG.CLIENT_ID}",
    ANTHROPIC_KEY:"${ENV_CONFIG.ANTHROPIC_KEY}",
    APP_URL:      "${appUrl}",
    REDIRECT_URI: "${appUrl}"
  };
</script>`;
  return htmlTemplate.replace('</head>', config + '\n</head>');
}

// Proxy Claude API calls server-side (hides API key from browser)
async function proxyClaudeApi(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const opts = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':       'application/json',
        'x-api-key':          ENV_CONFIG.ANTHROPIC_KEY,
        'anthropic-version':  '2023-06-01',
        'Content-Length':     data.length,
      }
    };
    const req = https.request(opts, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  // Health check for Railway
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', configured: !!ENV_CONFIG.CLIENT_ID }));
    return;
  }

  // Proxy Claude API — keeps API key server-side, never exposed to browser
  if (url === '/api/claude' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const result = await proxyClaudeApi(body);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(result.body);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
    return;
  }

  // Serve the main app
  if (url === '/' || url === '/index.html') {
    const html = buildHtml(req);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`PMS Ticketing running on port ${PORT}`);
  console.log(`Tenant ID:  ${ENV_CONFIG.TENANT_ID ? 'SET' : 'NOT SET'}`);
  console.log(`Client ID:  ${ENV_CONFIG.CLIENT_ID ? 'SET' : 'NOT SET'}`);
  console.log(`Claude Key: ${ENV_CONFIG.ANTHROPIC_KEY ? 'SET' : 'NOT SET'}`);
});
