const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const PORT = process.env.PORT || 3000;

const ENV_CONFIG = {
  TENANT_ID:     process.env.AZURE_TENANT_ID   || '',
  CLIENT_ID:     process.env.AZURE_CLIENT_ID   || '',
  ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY || '',
  APP_URL:       process.env.RAILWAY_STATIC_URL
                 ? 'https://' + process.env.RAILWAY_STATIC_URL
                 : (process.env.APP_URL || 'http://localhost:' + PORT),
};

// PostgreSQL — optional, graceful fallback if DATABASE_URL not set
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  pool.query(`
    CREATE TABLE IF NOT EXISTS pms_tickets (
      id         TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
    .then(() => console.log('DB ready'))
    .catch(e => console.error('DB init error:', e.message));
}

let htmlTemplate = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');

function buildHtml(req) {
  const host   = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto  = req.headers['x-forwarded-proto'] || 'https';
  const appUrl = host ? proto + '://' + host : ENV_CONFIG.APP_URL;
  const config = `
<script>
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

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });
}

async function proxyClaudeApi(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const opts = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ENV_CONFIG.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length':    data.length,
      },
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  // Health check
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', db: !!pool, configured: !!ENV_CONFIG.CLIENT_ID }));
    return;
  }

  // GET /api/tickets — return all tickets ordered by created date
  if (url === '/api/tickets' && req.method === 'GET') {
    if (!pool) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return; }
    try {
      const result = await pool.query(
        `SELECT data FROM pms_tickets ORDER BY (data->>'created') DESC`
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.rows.map(r => r.data)));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/tickets/delete-many — delete an array of ticket IDs from DB
  if (url === '/api/tickets/delete-many' && req.method === 'POST') {
    if (!pool) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
    try {
      const body = await readBody(req);
      const ids = JSON.parse(body);
      if (!Array.isArray(ids)) throw new Error('Expected array of IDs');
      for (const id of ids) {
        await pool.query('DELETE FROM pms_tickets WHERE id = $1', [id]);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deleted: ids.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/tickets/save — upsert full ticket array (batch sync from client)
  if (url === '/api/tickets/save' && req.method === 'POST') {
    if (!pool) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
    try {
      const body = await readBody(req);
      const tickets = JSON.parse(body);
      if (!Array.isArray(tickets)) throw new Error('Expected array');
      for (const ticket of tickets) {
        if (!ticket.id) continue;
        await pool.query(
          `INSERT INTO pms_tickets (id, data, updated_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (id) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
          [ticket.id, JSON.stringify(ticket)]
        );
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count: tickets.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/claude — proxy to Anthropic (keeps API key server-side)
  if (url === '/api/claude' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const result = await proxyClaudeApi(body);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(result.body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
    return;
  }

  // Serve app
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
  console.log(`DB:         ${pool ? 'PostgreSQL connected' : 'Not configured (localStorage only)'}`);
  console.log(`Tenant ID:  ${ENV_CONFIG.TENANT_ID ? 'SET' : 'NOT SET'}`);
  console.log(`Client ID:  ${ENV_CONFIG.CLIENT_ID ? 'SET' : 'NOT SET'}`);
  console.log(`Claude Key: ${ENV_CONFIG.ANTHROPIC_KEY ? 'SET' : 'NOT SET'}`);
});
