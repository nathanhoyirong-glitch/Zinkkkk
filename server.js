const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const TICK_RATE = 30; // ticks per second
const ARENA_SIZE = 2000;
const TANK_SIZE = 34; // square side length
const TANK_SPEED = 240; // px/sec
const BULLET_SPEED = 620; // px/sec
const BULLET_RADIUS = 6;
const BULLET_LIFETIME = 1.4; // seconds
const SHOOT_COOLDOWN = 0.28; // seconds
const MAX_HEALTH = 100;
const BULLET_DAMAGE = 12;
const RESPAWN_DELAY = 2.2; // seconds
const MAX_PLAYERS_PER_ROOM = 4;

// --- Room state ---
function makeRoom(id, name) {
  return {
    id,
    name,
    players: new Map(), // id -> player
    bullets: [], // {id, ownerId, x, y, vx, vy, age}
    spectators: new Set(), // ws set
    nextBulletId: 1,
  };
}

const rooms = {
  room1: makeRoom('room1', 'Room 1'),
  room2: makeRoom('room2', 'Room 2'),
};

let nextPlayerId = 1;

function randomSpawn() {
  const margin = 150;
  return {
    x: margin + Math.random() * (ARENA_SIZE - margin * 2),
    y: margin + Math.random() * (ARENA_SIZE - margin * 2),
  };
}

function makePlayer(id, ws, name) {
  const spawn = randomSpawn();
  return {
    id,
    ws,
    name: name || `Tank${id}`,
    x: spawn.x,
    y: spawn.y,
    angle: 0,
    vx: 0,
    vy: 0,
    input: { moveX: 0, moveY: 0, aim: 0, shooting: false },
    health: MAX_HEALTH,
    alive: true,
    respawnTimer: 0,
    shootCooldown: 0,
    kills: 0,
    deaths: 0,
  };
}

function clampToArena(v, size) {
  return Math.max(size / 2, Math.min(ARENA_SIZE - size / 2, v));
}

function broadcastRoom(room, dataObj) {
  const msg = JSON.stringify(dataObj);
  for (const p of room.players.values()) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
  for (const ws of room.spectators) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function roomSummary() {
  return Object.values(rooms).map(r => ({
    id: r.id,
    name: r.name,
    players: r.players.size,
    max: MAX_PLAYERS_PER_ROOM,
    spectators: r.spectators.size,
  }));
}

function broadcastLobbyCounts() {
  const msg = JSON.stringify({ type: 'lobby', rooms: roomSummary() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.inLobby) {
      client.send(msg);
    }
  });
}

// --- Physics / game loop ---
function stepRoom(room, dt) {
  // players
  for (const p of room.players.values()) {
    if (!p.alive) {
      p.respawnTimer -= dt;
      if (p.respawnTimer <= 0) {
        const spawn = randomSpawn();
        p.x = spawn.x;
        p.y = spawn.y;
        p.health = MAX_HEALTH;
        p.alive = true;
      }
      continue;
    }

    let dx = p.input.moveX || 0;
    let dy = p.input.moveY || 0;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    p.x = clampToArena(p.x + dx * TANK_SPEED * dt, TANK_SIZE);
    p.y = clampToArena(p.y + dy * TANK_SPEED * dt, TANK_SIZE);
    p.angle = p.input.aim;

    if (p.shootCooldown > 0) p.shootCooldown -= dt;
    if (p.input.shooting && p.shootCooldown <= 0) {
      p.shootCooldown = SHOOT_COOLDOWN;
      const barrelLen = TANK_SIZE * 0.9;
      room.bullets.push({
        id: room.nextBulletId++,
        ownerId: p.id,
        x: p.x + Math.cos(p.angle) * barrelLen,
        y: p.y + Math.sin(p.angle) * barrelLen,
        vx: Math.cos(p.angle) * BULLET_SPEED,
        vy: Math.sin(p.angle) * BULLET_SPEED,
        age: 0,
      });
    }
  }

  // bullets
  room.bullets = room.bullets.filter(b => {
    b.age += dt;
    if (b.age > BULLET_LIFETIME) return false;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.x < 0 || b.x > ARENA_SIZE || b.y < 0 || b.y > ARENA_SIZE) return false;

    for (const p of room.players.values()) {
      if (!p.alive || p.id === b.ownerId) continue;
      const half = TANK_SIZE / 2;
      if (
        b.x > p.x - half && b.x < p.x + half &&
        b.y > p.y - half && b.y < p.y + half
      ) {
        p.health -= BULLET_DAMAGE;
        if (p.health <= 0) {
          p.alive = false;
          p.deaths += 1;
          p.respawnTimer = RESPAWN_DELAY;
          const shooter = room.players.get(b.ownerId);
          if (shooter) shooter.kills += 1;
        }
        return false; // bullet consumed
      }
    }
    return true;
  });
}

function snapshotRoom(room) {
  return {
    type: 'state',
    roomId: room.id,
    roomName: room.name,
    arena: ARENA_SIZE,
    tankSize: TANK_SIZE,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      angle: p.angle,
      health: p.health,
      alive: p.alive,
      kills: p.kills,
      deaths: p.deaths,
    })),
    bullets: room.bullets.map(b => ({ id: b.id, x: b.x, y: b.y })),
    spectatorCount: room.spectators.size,
  };
}

setInterval(() => {
  const dt = 1 / TICK_RATE;
  for (const room of Object.values(rooms)) {
    if (room.players.size === 0 && room.spectators.size === 0) continue;
    stepRoom(room, dt);
    broadcastRoom(room, snapshotRoom(room));
  }
}, 1000 / TICK_RATE);

// --- Connection handling ---
wss.on('connection', ws => {
  ws.inLobby = true;
  ws.currentRoomId = null;
  ws.playerId = null;
  ws.isSpectator = false;

  ws.send(JSON.stringify({ type: 'lobby', rooms: roomSummary() }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'join') {
      const room = rooms[msg.roomId];
      if (!room) return;

      if (msg.spectate) {
        ws.inLobby = false;
        ws.isSpectator = true;
        ws.currentRoomId = room.id;
        room.spectators.add(ws);
        ws.send(JSON.stringify({ type: 'joined', roomId: room.id, roomName: room.name, spectate: true }));
        broadcastLobbyCounts();
        return;
      }

      if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room is full.' }));
        return;
      }

      const id = nextPlayerId++;
      const player = makePlayer(id, ws, msg.name);
      room.players.set(id, player);
      ws.inLobby = false;
      ws.currentRoomId = room.id;
      ws.playerId = id;
      ws.isSpectator = false;

      ws.send(JSON.stringify({ type: 'joined', roomId: room.id, roomName: room.name, selfId: id, spectate: false }));
      broadcastLobbyCounts();
    }

    if (msg.type === 'input' && ws.playerId && ws.currentRoomId) {
      const room = rooms[ws.currentRoomId];
      if (!room) return;
      const player = room.players.get(ws.playerId);
      if (!player) return;
      if (typeof msg.moveX === 'number') player.input.moveX = msg.moveX;
      if (typeof msg.moveY === 'number') player.input.moveY = msg.moveY;
      player.input.shooting = !!msg.shooting;
      if (typeof msg.aim === 'number') player.input.aim = msg.aim;
    }

    if (msg.type === 'leave') {
      leaveCurrent(ws);
      ws.inLobby = true;
      ws.send(JSON.stringify({ type: 'lobby', rooms: roomSummary() }));
    }
  });

  ws.on('close', () => {
    leaveCurrent(ws);
    broadcastLobbyCounts();
  });
});

function leaveCurrent(ws) {
  if (!ws.currentRoomId) return;
  const room = rooms[ws.currentRoomId];
  if (room) {
    if (ws.isSpectator) room.spectators.delete(ws);
    else if (ws.playerId) room.players.delete(ws.playerId);
  }
  ws.currentRoomId = null;
  ws.playerId = null;
  ws.isSpectator = false;
}

server.listen(PORT, () => {
  console.log(`Zinkk2 server running on port ${PORT}`);
});
