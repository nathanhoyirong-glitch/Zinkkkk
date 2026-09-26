// Tank Arena -- standalone multiplayer server
//
// Serves the game (public/index.html) as static files and runs a
// WebSocket endpoint at /ws that mirrors the small "room" protocol the
// client expects: each connection gets a peer id, can push presence
// updates (merged server-side and rebroadcast to everyone), and can
// emit one-off events (shoot / kill) that get relayed to other peers.
//
// Run locally:   npm install && npm start
// Deploy (Render, Railway, Fly, a VPS, etc.): any host that runs a
// long-lived Node process and exposes the PORT env var works. Static
// hosts like GitHub Pages / Netlify will NOT work for this file --
// they can't run server.js, only serve the client.

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const fs = require('fs');
const app = express();

const publicDir = path.join(__dirname, 'public');
const servingDir = fs.existsSync(path.join(publicDir, 'index.html')) ? publicDir : __dirname;
console.log('Serving static files from: ' + servingDir);
app.use(express.static(servingDir));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.get('/', (req, res, next) => {
  const indexPath = path.join(servingDir, 'index.html');
  if (fs.existsSync(indexPath)) return next();
  res.status(500).send(
    'index.html was not found next to server.js (checked ./public and ./).\n' +
    'Make sure your GitHub repo actually contains index.html -- ' +
    'check the repo file list on github.com.'
  );
});

// peerId -> { ws, presence: {} }
const peers = new Map();

// Hosted rooms live entirely in player presence (roomId 'H-XXXXX' plus a
// roomMeta {name,map,cap}). Clamp whatever clients send so a bad client
// can't push odd room ids or oversized values to everyone else.
const ROOM_ID_RE = /^(A|B|H-[A-Z0-9]{5})$/;
const KNOWN_MAPS = new Set(['crossfire', 'flats', 'fortress', 'switchback', 'grid', 'cross']);
// Hosted-room game modes. 'ffa' (default) is every-tank-for-itself, exactly
// like Room 1 / Room 2. 'teams' splits players into two sides (no friendly
// fire, team score = sum of member kills). 'ctf' adds a flag each side must
// steal and bring home. All the actual mode logic lives client-side in
// index.html; the server only needs to keep the tag from being tampered
// with into something unexpected.
const KNOWN_MODES = new Set(['ffa', 'teams', 'ctf']);
const KNOWN_TEAMS = new Set(['red', 'blue']);
// ---- admin (/admin in-game) ----
// Admin now signs in with a username + password (not just a password),
// via ADMIN_USERNAME / ADMIN_PASSWORD env vars (defaults: test1 / 111111
// -- set your own on your host!). "Remember me" uses a token derived from
// both, so it survives restarts and stops working if either changes.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'test1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '111111';
const ADMIN_TOKEN = crypto.createHmac('sha256', ADMIN_PASSWORD).update('tank-arena-admin-v1:' + ADMIN_USERNAME.toLowerCase()).digest('hex');
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const safeUsernameEq = (a, b) => safeEq(String(a || '').toLowerCase(), String(b || '').toLowerCase());
// True when a username+password pair matches the admin credentials --
// used so signing in with those credentials through the ordinary front-page
// account form (SIGN IN / REGISTER) also grants admin powers directly,
// with no separate /admin login step required.
const isAdminCreds = (username, password) =>
  typeof username === 'string' && typeof password === 'string' &&
  safeUsernameEq(username, ADMIN_USERNAME) && safeEq(password, ADMIN_PASSWORD);
// /ban @player (admin-only) bans by IP, in-memory. Resets on a server
// restart -- there's no database here, and that's fine for a casual
// friends server; swap this for a persisted store if you need it to stick.
// Map so we can show admins who they banned and when -- keyed by IP since
// that's the actual thing being blocked.
const bannedIPs = new Map(); // ip -> { name, bannedAt }
function banListPayload() {
  return Array.from(bannedIPs.entries())
    .map(([ip, info]) => ({ ip, name: info.name, bannedAt: info.bannedAt }))
    .sort((a, b) => b.bannedAt - a.bannedAt);
}

// ---- accounts (persistent cross-room kill totals, admin-manageable) ----
// In-memory, like the ban list -- resets if the server restarts. Keyed by
// lowercased username so sign-in is case-insensitive; the original-case
// username is kept for display. Sessions map a "remember me" token back to
// an account so a browser can silently re-authenticate on reconnect,
// without ever storing the password itself client-side.
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const accounts = new Map();  // usernameLower -> { username, salt, hash, kills, createdAt }
const sessions = new Map();  // token -> usernameLower
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function createSession(usernameLower) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, usernameLower);
  return token;
}
function dropSessionsFor(usernameLower) {
  for (const [token, u] of sessions) if (u === usernameLower) sessions.delete(token);
}
// Public leaderboard -- total kills per account, aggregated across every
// room and hosted match on this server (kills are credited to whichever
// account is signed in on the shooter's connection at the moment of the
// kill; unsigned-in players still play fine, they just don't appear here).
function leaderboardPayload() {
  return Array.from(accounts.values())
    .sort((a, b) => b.kills - a.kills || a.createdAt - b.createdAt)
    .slice(0, 50)
    .map(a => ({ username: a.username, kills: a.kills }));
}
function broadcastLeaderboard() {
  sendAll({ type: 'leaderboard', top: leaderboardPayload() });
}

const KNOWN_TANKS = new Set(['single', 'dual', 'triple', 'parallel', 'omni', 'triplet', 'quad', 'necro', 'octo']);
function sanitizePresence(d) {
  if ('adminTank' in d && d.adminTank !== null && !KNOWN_TANKS.has(d.adminTank)) delete d.adminTank;
  if ('roomId' in d && d.roomId !== null && !(typeof d.roomId === 'string' && ROOM_ID_RE.test(d.roomId))) delete d.roomId;
  if ('roomMeta' in d && d.roomMeta !== null) {
    const m = d.roomMeta;
    if (!m || typeof m !== 'object') delete d.roomMeta;
    else d.roomMeta = {
      name: String(m.name || 'CUSTOM ROOM').slice(0, 20),
      map: KNOWN_MAPS.has(m.map) ? m.map : 'crossfire',
      cap: Math.max(2, Math.min(10, parseInt(m.cap, 10) || 4)),
      mode: KNOWN_MODES.has(m.mode) ? m.mode : 'ffa',
      started: !!m.started
    };
  }
  if ('team' in d && d.team !== null && !KNOWN_TEAMS.has(d.team)) delete d.team;
  if ('carrying' in d && d.carrying !== null && !KNOWN_TEAMS.has(d.carrying)) delete d.carrying;
  return d;
}

function deepMerge(target, patch) {
  for (const key of Object.keys(patch || {})) {
    const val = patch[key];
    if (val && typeof val === 'object' && !Array.isArray(val) &&
        target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepMerge(target[key], val);
    } else {
      target[key] = val;
    }
  }
  return target;
}

// How often presence changes go out to everyone, in Hz. Lower = less CPU/
// bandwidth per tick (kinder to constrained free-tier hosts), at the cost
// of remote players looking slightly less frequently-updated -- the client
// smooths between updates (see the interpolation code in index.html) so
// this can go fairly low without looking choppy.
const TICK_HZ = 25;
const TICK_MS = Math.round(1000 / TICK_HZ);

let peersDirty = false;
function markPeersDirty() { peersDirty = true; }
function broadcastPeersNow() {
  const list = Array.from(peers.entries()).map(([id, p]) => ({ peer: id, presence: p.presence }));
  const msg = JSON.stringify({ type: 'peers', list });
  for (const [, p] of peers) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}
setInterval(() => {
  if (!peersDirty) return;
  peersDirty = false;
  broadcastPeersNow();
}, TICK_MS);
function broadcastPeers() { markPeersDirty(); }

// ---------------------------------------------------------------
// Room 1 match timer (server-authoritative)
//
// Room 1 is sector 'A'. The moment it holds 2+ players a 10 minute
// countdown starts. When it hits zero everyone in the room is removed
// from it, and whoever has the highest kill score is announced the
// winner (ties are reported as a draw). If the room empties out
// before time is up, the match is cancelled and the next pair of
// players gets a fresh 10 minutes.
// ---------------------------------------------------------------
const TIMED_SECTOR = 'A';
const MATCH_MS = 10 * 60 * 1000;
const MIN_PLAYERS_TO_START = 2;
let match = null; // { endsAt: epoch ms } while a match is running

function playersIn(sector) {
  return Array.from(peers.entries()).filter(([, p]) => p.presence && p.presence.roomId === sector);
}
function sendAll(obj) {
  const msg = JSON.stringify(obj);
  for (const [, p] of peers) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}
function matchMessage() {
  return { type: 'match', sector: TIMED_SECTOR, endsAt: match ? match.endsAt : null, now: Date.now() };
}
function evaluateMatch() {
  const n = playersIn(TIMED_SECTOR).length;
  if (!match && n >= MIN_PLAYERS_TO_START) {
    match = { endsAt: Date.now() + MATCH_MS };
    console.log('Room 1 match started');
    sendAll(matchMessage());
  } else if (match && n === 0) {
    match = null;
    console.log('Room 1 emptied, match cancelled');
    sendAll(matchMessage());
  }
}
function endMatch() {
  const players = playersIn(TIMED_SECTOR);
  const results = players.map(([id, p]) => ({
    peer: id,
    name: p.presence.name || 'OPERATOR',
    color: p.presence.color,
    score: p.presence.score || 0
  })).sort((a, b) => b.score - a.score);
  const top = results.length ? results[0].score : 0;
  const winners = results.filter(r => r.score === top).map(r => r.peer);

  match = null;
  console.log('Room 1 match ended', JSON.stringify(results));
  sendAll({ type: 'matchEnd', sector: TIMED_SECTOR, results, winners });

  // kick everyone out of the room
  for (const [, p] of players) {
    p.presence.roomId = null;
    p.presence.alive = false;
    p.presence.hp = 0;
    p.presence.score = 0;
  }
  markPeersDirty();
  sendAll(matchMessage());
}
setInterval(() => {
  if (match && Date.now() >= match.endsAt) endMatch();
}, 500);

wss.on('connection', (ws, req) => {
  // Best-effort client IP -- respects a reverse proxy's X-Forwarded-For
  // (Render, most PaaS hosts) and falls back to the raw socket address.
  const fwd = req.headers && req.headers['x-forwarded-for'];
  const ip = (fwd ? String(fwd).split(',')[0].trim() : '') || (req.socket && req.socket.remoteAddress) || '';

  if (ip && bannedIPs.has(ip)) {
    ws.send(JSON.stringify({ type: 'banned' }));
    ws.close(4403, 'banned');
    return;
  }

  const id = crypto.randomUUID();
  peers.set(id, { ws, ip, presence: {}, account: null });
  ws.send(JSON.stringify({ type: 'welcome', peer: id }));
  ws.send(JSON.stringify(matchMessage()));
  ws.send(JSON.stringify({ type: 'leaderboard', top: leaderboardPayload() }));
  broadcastPeers();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const p = peers.get(id);
    if (!p) return;

    if (msg.type === 'ping') {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
    } else if (msg.type === 'presence' && msg.data && typeof msg.data === 'object') {
      const clean = sanitizePresence(msg.data);
      // Only an unlocked admin may set their OWN adminTank to a specific
      // override; anyone can still clear theirs back to null/AUTO (this is
      // what join/leave do), which matters now that an admin can set a
      // *different* player's tank via adminSetTank below -- without this,
      // a non-admin who'd been switched by someone else could never reset.
      if (!p.admin && clean.adminTank) delete clean.adminTank;
      deepMerge(p.presence, clean);
      broadcastPeers();
      evaluateMatch();
    } else if (msg.type === 'adminLogin') {
      const now = Date.now();
      const viaToken = typeof msg.token === 'string';
      if (p.lockedUntil && now < p.lockedUntil) {
        ws.send(JSON.stringify({ type: 'adminResult', ok: false, error: 'Too many attempts. Wait 30 seconds.' }));
        return;
      }
      const ok = viaToken ? safeEq(msg.token, ADMIN_TOKEN)
                          : (typeof msg.username === 'string' && typeof msg.password === 'string' &&
                             safeUsernameEq(msg.username, ADMIN_USERNAME) && safeEq(msg.password, ADMIN_PASSWORD));
      if (ok) {
        p.admin = true; p.fails = 0;
        ws.send(JSON.stringify({ type: 'adminResult', ok: true, token: ADMIN_TOKEN }));
      } else {
        p.fails = (p.fails || 0) + 1;
        if (p.fails >= 5) { p.lockedUntil = now + 30000; p.fails = 0; }
        ws.send(JSON.stringify({ type: 'adminResult', ok: false, error: 'Wrong username or password.' }));
      }
    } else if (msg.type === 'adminKill') {
      // admin-only; target must be in the same room as the admin
      if (!p.admin || typeof msg.target !== 'string') return;
      const t = peers.get(msg.target);
      if (!t || !p.presence.roomId || t.presence.roomId !== p.presence.roomId) return;
      if (t.ws.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ type: 'adminKill' }));
    } else if (msg.type === 'adminSetTank') {
      // admin-only; target must be in the same room as the admin. Unlike a
      // player's own presence updates (which strip adminTank unless THEY
      // are unlocked), this writes straight into the target's presence --
      // that's the whole point, it lets an admin flip someone else's tank.
      if (!p.admin || typeof msg.target !== 'string') return;
      const t = peers.get(msg.target);
      if (!t || !p.presence.roomId || t.presence.roomId !== p.presence.roomId) return;
      const tank = (msg.tank === null || msg.tank === undefined) ? null : String(msg.tank);
      if (tank !== null && !KNOWN_TANKS.has(tank)) return;
      t.presence.adminTank = tank;
      broadcastPeers();
    } else if (msg.type === 'adminBan') {
      // admin-only; target must be in the same room as the admin. Bans by
      // IP (in-memory, resets on restart) since peer ids are per-connection
      // and wouldn't survive a reload -- fine for a casual friends server.
      if (!p.admin || typeof msg.target !== 'string') return;
      const t = peers.get(msg.target);
      if (!t || !p.presence.roomId || t.presence.roomId !== p.presence.roomId) return;
      if (t.ip) bannedIPs.set(t.ip, { name: t.presence.name || 'OPERATOR', bannedAt: Date.now() });
      console.log('Banned', t.presence.name || msg.target, t.ip || '(no ip)');
      if (t.ws.readyState === WebSocket.OPEN) {
        t.ws.send(JSON.stringify({ type: 'banned' }));
        t.ws.close(4403, 'banned');
      }
      peers.delete(msg.target);
      broadcastPeers();
      evaluateMatch();
    } else if (msg.type === 'adminListBans') {
      if (!p.admin) return;
      ws.send(JSON.stringify({ type: 'adminBanList', bans: banListPayload() }));
    } else if (msg.type === 'adminUnban') {
      // Deliberately checked against the raw password, not just p.admin /
      // the remembered token -- unbanning is sensitive enough that we want
      // it typed again every time, even on a device that's stayed unlocked.
      if (!p.admin || typeof msg.ip !== 'string') return;
      const now = Date.now();
      if (p.unbanLockedUntil && now < p.unbanLockedUntil) {
        ws.send(JSON.stringify({ type: 'adminUnbanResult', ok: false, error: 'Too many attempts. Wait 30 seconds.' }));
        return;
      }
      const ok = typeof msg.password === 'string' && safeEq(msg.password, ADMIN_PASSWORD);
      if (!ok) {
        p.unbanFails = (p.unbanFails || 0) + 1;
        if (p.unbanFails >= 5) { p.unbanLockedUntil = now + 30000; p.unbanFails = 0; }
        ws.send(JSON.stringify({ type: 'adminUnbanResult', ok: false, error: 'Wrong password.' }));
        return;
      }
      p.unbanFails = 0;
      bannedIPs.delete(msg.ip);
      ws.send(JSON.stringify({ type: 'adminUnbanResult', ok: true, bans: banListPayload() }));
    } else if (msg.type === 'adminLogout') {
      p.admin = false;
      p.presence.adminTank = null;
      broadcastPeers();
    } else if (msg.type === 'register') {
      const username = typeof msg.username === 'string' ? msg.username.trim() : '';
      const password = typeof msg.password === 'string' ? msg.password : '';
      if (isAdminCreds(username, password)) {
        const key = ADMIN_USERNAME.toLowerCase();
        if (!accounts.has(key)) {
          const salt = crypto.randomBytes(16).toString('hex');
          accounts.set(key, { username: ADMIN_USERNAME, salt, hash: hashPassword(ADMIN_PASSWORD, salt), kills: 0, createdAt: Date.now() });
        }
        const acct = accounts.get(key);
        p.account = key; p.admin = true; p.fails = 0;
        const token = createSession(key);
        ws.send(JSON.stringify({ type: 'authResult', ok: true, username: acct.username, kills: acct.kills, token, isAdmin: true, adminToken: ADMIN_TOKEN }));
        broadcastLeaderboard();
        return;
      }
      if (!USERNAME_RE.test(username)) {
        ws.send(JSON.stringify({ type: 'authResult', ok: false, error: 'Username must be 3-16 letters, numbers or _.' }));
        return;
      }
      if (password.length < 4) {
        ws.send(JSON.stringify({ type: 'authResult', ok: false, error: 'Password must be at least 4 characters.' }));
        return;
      }
      const key = username.toLowerCase();
      if (accounts.has(key)) {
        ws.send(JSON.stringify({ type: 'authResult', ok: false, error: 'That username is taken.' }));
        return;
      }
      const salt = crypto.randomBytes(16).toString('hex');
      accounts.set(key, { username, salt, hash: hashPassword(password, salt), kills: 0, createdAt: Date.now() });
      p.account = key;
      const token = createSession(key);
      ws.send(JSON.stringify({ type: 'authResult', ok: true, username, kills: 0, token }));
      broadcastLeaderboard();
    } else if (msg.type === 'login') {
      const username = typeof msg.username === 'string' ? msg.username.trim() : '';
      const password = typeof msg.password === 'string' ? msg.password : '';
      if (isAdminCreds(username, password)) {
        const key = ADMIN_USERNAME.toLowerCase();
        if (!accounts.has(key)) {
          const salt = crypto.randomBytes(16).toString('hex');
          accounts.set(key, { username: ADMIN_USERNAME, salt, hash: hashPassword(ADMIN_PASSWORD, salt), kills: 0, createdAt: Date.now() });
        }
        const acct = accounts.get(key);
        p.account = key; p.admin = true; p.fails = 0;
        const token = createSession(key);
        ws.send(JSON.stringify({ type: 'authResult', ok: true, username: acct.username, kills: acct.kills, token, isAdmin: true, adminToken: ADMIN_TOKEN }));
        return;
      }
      const key = username.toLowerCase();
      const acct = accounts.get(key);
      if (!acct || hashPassword(password, acct.salt) !== acct.hash) {
        ws.send(JSON.stringify({ type: 'authResult', ok: false, error: 'Wrong username or password.' }));
        return;
      }
      p.account = key;
      const token = createSession(key);
      ws.send(JSON.stringify({ type: 'authResult', ok: true, username: acct.username, kills: acct.kills, token }));
    } else if (msg.type === 'authToken') {
      // silent re-auth on connect/reconnect from a saved "remember me" token
      const key = typeof msg.token === 'string' ? sessions.get(msg.token) : null;
      const acct = key ? accounts.get(key) : null;
      if (!acct) {
        ws.send(JSON.stringify({ type: 'authResult', ok: false, silent: true }));
        return;
      }
      p.account = key;
      const isAdminAcct = key === ADMIN_USERNAME.toLowerCase();
      if (isAdminAcct) { p.admin = true; p.fails = 0; }
      ws.send(JSON.stringify({ type: 'authResult', ok: true, username: acct.username, kills: acct.kills, token: msg.token, isAdmin: isAdminAcct, adminToken: isAdminAcct ? ADMIN_TOKEN : undefined }));
    } else if (msg.type === 'logoutAccount') {
      const wasAdminAcct = p.account === ADMIN_USERNAME.toLowerCase();
      p.account = null;
      if (wasAdminAcct) { p.admin = false; p.presence.adminTank = null; broadcastPeers(); }
    } else if (msg.type === 'adminDelete') {
      // admin-only; deletes the ACCOUNT (not just disconnects them), by
      // username rather than peer id, since the target may not even be
      // online right now.
      if (!p.admin || typeof msg.target !== 'string') return;
      const key = msg.target.trim().toLowerCase();
      const acct = accounts.get(key);
      if (!acct) {
        ws.send(JSON.stringify({ type: 'adminDeleteResult', ok: false, error: 'No account "' + msg.target.slice(0, 16) + '".' }));
        return;
      }
      accounts.delete(key);
      dropSessionsFor(key);
      for (const [, pp] of peers) {
        if (pp.account === key) {
          pp.account = null;
          if (pp.ws.readyState === WebSocket.OPEN) pp.ws.send(JSON.stringify({ type: 'accountDeleted' }));
        }
      }
      console.log('Admin deleted account', acct.username);
      ws.send(JSON.stringify({ type: 'adminDeleteResult', ok: true, username: acct.username }));
      broadcastLeaderboard();
    } else if (msg.type === 'getLeaderboard') {
      ws.send(JSON.stringify({ type: 'leaderboard', top: leaderboardPayload() }));
    } else if (msg.type === 'emit' && typeof msg.topic === 'string') {
      const out = JSON.stringify({ type: 'event', topic: msg.topic, data: msg.data, from: id });
      for (const [pid, pp] of peers) {
        if (pid === id) continue; // sender already renders its own action locally
        if (pp.ws.readyState === WebSocket.OPEN) pp.ws.send(out);
      }
      // Credit the public leaderboard: kills are attributed to whichever
      // account is signed in on the SHOOTER's connection (the kill event
      // itself is emitted by the victim's client, so we look the shooter
      // up by id rather than by who sent this message).
      if (msg.topic === 'kill' && msg.data && typeof msg.data.shooterId === 'string') {
        const shooter = peers.get(msg.data.shooterId);
        if (shooter && shooter.account) {
          const acct = accounts.get(shooter.account);
          if (acct) {
            acct.kills += 1;
            if (shooter.ws.readyState === WebSocket.OPEN) {
              shooter.ws.send(JSON.stringify({ type: 'accountKills', kills: acct.kills }));
            }
            broadcastLeaderboard();
          }
        }
      }
    }
  });

  ws.on('close', () => {
    peers.delete(id);
    broadcastPeers();
    evaluateMatch();
  });

  ws.on('error', () => {
    peers.delete(id);
    broadcastPeers();
    evaluateMatch();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Tank Arena server listening on port ' + PORT);
});
