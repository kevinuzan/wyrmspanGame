// Wyrmspan Online — servidor de salas (HTTP estático + WebSocket)
// Mesmo padrão dos outros projetos no Railway: server.mjs, process.env.PORT, pasta public/, "npm start".
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

/* ------------------------------------------------------------------ HTTP */
const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // HTML e cartas.json sempre frescos: atualizou o JSON, o próximo F5 já pega.
    if (ext === '.html' || ext === '.json') headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
});

/* ------------------------------------------------------------ Salas (WS) */
const MAX_SEATS = 5;
const HOST_SEAT = 0;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();

function genCode() {
  for (let tries = 0; tries < 100; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('sem códigos livres');
}

function makeRoom(code) {
  return {
    code,
    seats: Array(MAX_SEATS).fill(null), // { name, token, ws }
    phase: 'lobby',
    v: 0,
    stateStr: null,
    turnStr: null, // estado no início do turno atual (para "Desfazer" após recarregar a página)
    restored: false,
    touched: Date.now(),
  };
}

const isOpen = (ws) => ws && ws.readyState === 1;
const cleanName = (s) =>
  String(s || '').replace(/[<>&"'`\\]/g, '').trim().slice(0, 24) || 'Dracologista';

function pubSeats(room) {
  return room.seats.map((s) => (s ? { name: s.name, connected: isOpen(s.ws) } : null));
}

function broadcastPresence(room) {
  const msg = JSON.stringify({ t: 'presence', seats: pubSeats(room), host: HOST_SEAT });
  room.seats.forEach((s) => s && isOpen(s.ws) && s.ws.send(msg));
}

function send(ws, obj) {
  if (isOpen(ws)) ws.send(JSON.stringify(obj));
}

function detach(ws) {
  const ctx = ws.ctx;
  if (!ctx) return;
  ws.ctx = null;
  const seat = ctx.room.seats[ctx.seat];
  if (seat && seat.ws === ws) seat.ws = null;
  ctx.room.touched = Date.now();
}

function handleHello(ws, m) {
  detach(ws);
  const name = cleanName(m.name);
  const token = String(m.token || '');
  if (!token) return send(ws, { t: 'error', message: 'Token ausente.', fatal: true });

  let room;
  let seatIdx = -1;

  if (m.create) {
    room = makeRoom(genCode());
    rooms.set(room.code, room);
    seatIdx = HOST_SEAT;
  } else {
    const code = String(m.room || '').toUpperCase().trim();
    room = rooms.get(code);
    if (!room) {
      // Servidor reiniciou (deploy)? Os clientes ainda têm o estado: reconstruímos a sala.
      const r = m.restore;
      if (r && Number.isInteger(m.seat) && m.seat >= 0 && m.seat < MAX_SEATS && /^[A-Z0-9]{4}$/.test(code)) {
        room = makeRoom(code);
        room.restored = true;
        room.phase = typeof r.phase === 'string' ? r.phase : 'lobby';
        room.v = Number.isFinite(r.v) ? r.v : 0;
        room.stateStr = r.state ? JSON.stringify(r.state) : null;
        room.turnStr = r.turnStart ? JSON.stringify(r.turnStart) : null;
        rooms.set(code, room);
      } else {
        return send(ws, { t: 'noroom' });
      }
    }

    seatIdx = room.seats.findIndex((s) => s && s.token === token);
    if (seatIdx < 0 && room.restored && Number.isInteger(m.seat) && m.seat >= 0 && m.seat < MAX_SEATS && !room.seats[m.seat]) {
      seatIdx = m.seat;
    }
    if (seatIdx < 0) {
      // Voltando de outro aparelho/aba: mesmo nome de alguém que está offline
      seatIdx = room.seats.findIndex((s) => s && !isOpen(s.ws) && s.name.toLowerCase() === name.toLowerCase());
    }
    if (seatIdx < 0) {
      if (room.phase !== 'lobby') {
        return send(ws, {
          t: 'error',
          fatal: true,
          message: 'A partida já começou. Para voltar, entre com o mesmo nome de quem saiu.',
        });
      }
      seatIdx = room.seats.findIndex((s) => !s);
      if (seatIdx < 0) return send(ws, { t: 'error', fatal: true, message: 'Sala cheia (máximo 5 jogadores).' });
    }
  }

  const prev = room.seats[seatIdx];
  if (prev && prev.ws && prev.ws !== ws && isOpen(prev.ws)) {
    prev.ws.ctx = null;
    prev.ws.close(4000, 'replaced');
  }
  room.seats[seatIdx] = { name, token, ws };
  ws.ctx = { room, seat: seatIdx };
  room.touched = Date.now();

  ws.send(
    `{"t":"joined","room":"${room.code}","seat":${seatIdx},"seats":${JSON.stringify(pubSeats(room))},` +
      `"phase":${JSON.stringify(room.phase)},"v":${room.v},"state":${room.stateStr || 'null'},"turnStart":${room.turnStr || 'null'}}`
  );
  broadcastPresence(room);
}

function handleMessage(ws, m) {
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'hello') return handleHello(ws, m);

  const ctx = ws.ctx;
  if (!ctx) return;
  const room = ctx.room;
  room.touched = Date.now();

  switch (m.t) {
    case 'state': {
      if (!Number.isFinite(m.v) || m.v <= room.v || !m.state) return;
      room.v = m.v;
      if (typeof m.phase === 'string') room.phase = m.phase;
      room.stateStr = JSON.stringify(m.state);
      if (m.handoff) room.turnStr = room.stateStr;
      const out =
        `{"t":"state","v":${room.v},"phase":${JSON.stringify(room.phase)},"handoff":${Boolean(m.handoff)},"state":${room.stateStr}}`;
      room.seats.forEach((s, i) => {
        if (s && i !== ctx.seat && isOpen(s.ws)) s.ws.send(out);
      });
      break;
    }
    case 'to': {
      const target = room.seats[m.seat];
      if (target && isOpen(target.ws)) send(target.ws, { t: 'msg', from: ctx.seat, msg: m.msg });
      break;
    }
    case 'reset': {
      room.phase = 'lobby';
      room.v = 0;
      room.stateStr = null;
      room.turnStr = null;
      const msg = JSON.stringify({ t: 'reset' });
      room.seats.forEach((s) => s && isOpen(s.ws) && s.ws.send(msg));
      broadcastPresence(room);
      break;
    }
    case 'leave': {
      const idx = ctx.seat;
      detach(ws);
      if (room.phase === 'lobby') room.seats[idx] = null;
      if (room.seats.every((s) => !s)) rooms.delete(room.code);
      else broadcastPresence(room);
      break;
    }
  }
}

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 8 * 1024 * 1024,
  perMessageDeflate: { threshold: 1024 },
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.ctx = null;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (data) => {
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    try {
      handleMessage(ws, m);
    } catch (e) {
      console.error('erro ao tratar mensagem:', e);
    }
  });
  ws.on('close', () => {
    const ctx = ws.ctx;
    detach(ws);
    if (ctx) broadcastPresence(ctx.room);
  });
  ws.on('error', () => {});
});

// Mantém as conexões vivas atrás do proxy do Railway e derruba as mortas
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

// Limpa salas abandonadas há mais de 24h
setInterval(() => {
  const limit = Date.now() - 24 * 3600 * 1000;
  for (const [code, room] of rooms) {
    const anyOnline = room.seats.some((s) => s && isOpen(s.ws));
    if (!anyOnline && room.touched < limit) rooms.delete(code);
  }
}, 30 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Wyrmspan Online rodando na porta ${PORT}`);
});
