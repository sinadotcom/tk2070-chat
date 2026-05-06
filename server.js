// TK2070 chat server: HTTP (static + login API) + WebSocket (real-time broadcast)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const USERS = [
  { id: 'fa', name: 'Furkan Ayın',    password: 'fa2070', initials: 'FA', bg: '#ffd9b2', fg: '#663300' },
  { id: 'ty', name: 'Tuğba Yavuz',    password: 'ty2070', initials: 'TY', bg: '#f7d5c4', fg: '#6a3216' },
  { id: 'sy', name: 'Sina Yaşar',     password: 'sy2070', initials: 'SY', bg: '#eeb0b8', fg: '#6f000e' },
  { id: 'nk', name: 'Nagehan Kekili', password: 'nk2070', initials: 'NK', bg: '#a0e6ba', fg: '#136c34' },
  { id: 'fd', name: 'Furkan Durgun',  password: 'fd2070', initials: 'FD', bg: '#dadee3', fg: '#34404f' },
];
const PUBLIC_USERS = USERS.map(({ password, ...rest }) => rest);

const messages = []; // in-memory message log (last 200)
const sessions = new Map(); // token -> userId

const makeId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const nowTime = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const ROOT = __dirname;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/users') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(PUBLIC_USERS));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { userId, password } = JSON.parse(body || '{}');
        const u = USERS.find((x) => x.id === userId);
        if (!u || u.password !== password) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Hesap veya şifre hatalı.' }));
          return;
        }
        const token = makeId();
        sessions.set(token, u.id);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          token,
          user: { id: u.id, name: u.name, initials: u.initials, bg: u.bg, fg: u.fg },
        }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Geçersiz istek.' }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { token } = JSON.parse(body || '{}');
        sessions.delete(token);
      } catch {}
      res.writeHead(204);
      res.end();
    });
    return;
  }

  // Static file
  let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

const broadcast = (msg, exclude) => {
  const data = JSON.stringify(msg);
  wss.clients.forEach((c) => {
    if (c !== exclude && c.readyState === 1) c.send(data);
  });
};

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const userId = sessions.get(token);
  if (!userId) {
    try { ws.send(JSON.stringify({ type: 'error', error: 'auth' })); } catch {}
    ws.close();
    return;
  }
  ws.userId = userId;

  // send history snapshot to the new client
  try { ws.send(JSON.stringify({ type: 'history', messages })); } catch {}

  // announce presence
  broadcast({ type: 'presence', userId, online: true });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'message') {
      const text = (typeof msg.text === 'string') ? msg.text.trim().slice(0, 1000) : '';
      // Validate optional image (data URL string)
      let image = null;
      if (typeof msg.image === 'string' && msg.image.startsWith('data:image/') && msg.image.length < 2_800_000) {
        image = msg.image;
      }
      // Validate optional file { name, mime, size, dataUrl }
      let file = null;
      if (msg.file && typeof msg.file === 'object'
          && typeof msg.file.dataUrl === 'string'
          && msg.file.dataUrl.startsWith('data:')
          && msg.file.dataUrl.length < 2_800_000
          && typeof msg.file.name === 'string') {
        file = {
          name: msg.file.name.slice(0, 200),
          mime: typeof msg.file.mime === 'string' ? msg.file.mime.slice(0, 100) : 'application/octet-stream',
          size: Number.isFinite(msg.file.size) ? Math.min(msg.file.size, 2_800_000) : 0,
          dataUrl: msg.file.dataUrl,
        };
      }
      // Validate optional mentions array (userIds, deduped, max 10, never self)
      const mentions = [];
      if (Array.isArray(msg.mentions)) {
        const validIds = new Set(USERS.map((u) => u.id));
        for (const id of msg.mentions) {
          if (typeof id !== 'string') continue;
          if (!validIds.has(id)) continue;
          if (id === userId) continue; // can't mention yourself
          if (mentions.includes(id)) continue;
          mentions.push(id);
          if (mentions.length >= 10) break;
        }
      }
      // Must have at least one of: text / image / file
      if (!text && !image && !file) return;
      const m = {
        id: makeId(),
        senderId: userId,
        text,
        time: nowTime(),
      };
      if (image) m.image = image;
      if (file) m.file = file;
      if (mentions.length) m.mentions = mentions;
      messages.push(m);
      if (messages.length > 200) messages.shift();
      broadcast({ type: 'message', message: m });
    } else if (msg.type === 'typing') {
      broadcast({ type: 'typing', userId, on: !!msg.on }, ws);
    }
  });

  ws.on('close', () => {
    broadcast({ type: 'presence', userId, online: false });
  });
});

const PORT = Number(process.env.PORT) || 5173;
server.listen(PORT, () => {
  console.log(`TK2070 chat server running on http://localhost:${PORT}`);
});
