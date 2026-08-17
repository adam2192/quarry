/**
 * QUARRY — real-world hunter vs prey.
 *
 * The server is the only thing that knows where everyone is in real time.
 * Phones stream their location here continuously, but the server only
 * *reveals* a position to the room when a reveal timer fires. That's the
 * whole game: you're invisible until the clock says otherwise.
 *
 * Catches are logged by honor system, not GPS: a hunter who catches
 * someone in person taps that player's name in the app to convert them.
 * There's no distance check — the app trusts the room.
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TICK_MS = 1000;
const BROADCAST_EVERY_MS = 5000;   // heartbeat so "last seen" stays honest
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** @type {Map<string, Room>} */
const rooms = new Map();

const defaultSettings = () => ({
  preyRevealSec: 600,      // how often prey positions go public, once pinging has begun
  hunterRevealSec: 600,    // how often hunter positions go public, once pinging has begun
  onCatch: 'convert',      // convert | eliminate | swap
  revealOnCatch: true,     // logging a catch also reveals everyone immediately
});

// ---------------------------------------------------------------- utilities

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function log(room, msg, kind = 'info') {
  room.log.unshift({ at: Date.now(), msg, kind });
  room.log.length = Math.min(room.log.length, 60);
}

// ------------------------------------------------------------------- rooms

function createRoom() {
  const room = {
    code: makeCode(),
    createdAt: Date.now(),
    status: 'lobby', // lobby | running | over
    settings: defaultSettings(),
    players: new Map(),
    hostId: null,
    startedAt: null,
    // Both null until the host sends the first ping. No countdown, no
    // automatic reveal — the clock only starts once the host says so.
    nextPreyReveal: null,
    nextHunterReveal: null,
    outcome: null,
    log: [],
    lastBroadcast: 0,
  };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, name) {
  const player = {
    id: crypto.randomUUID(),
    name: name.slice(0, 16),
    role: 'prey',
    alive: true,
    connected: true,
    live: null,      // { lat, lng, acc, at }  — private, server-side only
    shown: null,     // { lat, lng, acc, at }  — last publicly revealed fix
    prevShown: null,
    joinedAt: Date.now(),
  };
  room.players.set(player.id, player);
  if (!room.hostId) room.hostId = player.id;
  return player;
}

const living = (room, role) =>
  [...room.players.values()].filter((p) => p.alive && (!role || p.role === role));

// ---------------------------------------------------------------- the game

function startGame(room) {
  const now = Date.now();
  const hunters = living(room, 'hunter').length;
  const prey = living(room, 'prey').length;
  if (!hunters || !prey) return 'Set at least one hunter and one prey first.';

  room.status = 'running';
  room.startedAt = now;
  room.nextPreyReveal = null;
  room.nextHunterReveal = null;
  room.outcome = null;
  for (const p of room.players.values()) {
    p.shown = null;
    p.prevShown = null;
    p.alive = true;
  }
  log(room, 'Hunt started. Everyone hide — the host sends the first ping when ready.', 'big');
  return null;
}

function reveal(room, group, note) {
  const now = Date.now();
  for (const p of room.players.values()) {
    if (!p.alive || !p.live) continue;
    if (group !== 'all' && p.role !== group) continue;
    p.prevShown = p.shown;
    p.shown = { ...p.live, revealedAt: now };
  }
  room.lastReveal = { at: now, group };
  if (note) log(room, note, 'ping');
}

function endGame(room, outcome, note) {
  room.status = 'over';
  room.outcome = outcome;
  reveal(room, 'all');
  log(room, note, 'big');
}

// The host-triggered "first ping" and any later manual reveal share this:
// reveal everyone right now, then schedule the next automatic ping for
// each faction from this moment.
function sendPing(room, note) {
  const now = Date.now();
  reveal(room, 'all', note);
  room.nextPreyReveal = now + room.settings.preyRevealSec * 1000;
  room.nextHunterReveal = now + room.settings.hunterRevealSec * 1000;
}

function declareCatch(room, hunter, targetId) {
  if (room.status !== 'running') return 'The hunt is not running.';
  if (hunter.role !== 'hunter') return 'Only hunters can log a catch.';
  const target = room.players.get(targetId);
  if (!target) return 'Player not found.';
  if (target.role !== 'prey' || !target.alive) return `${target.name} isn't prey right now.`;

  const rule = room.settings.onCatch;
  if (rule === 'eliminate') {
    target.alive = false;
    log(room, `${hunter.name} caught ${target.name}. Out of the game.`, 'catch');
  } else if (rule === 'swap') {
    target.role = 'hunter';
    hunter.role = 'prey';
    log(room, `${hunter.name} caught ${target.name}. Roles swapped.`, 'catch');
  } else {
    target.role = 'hunter';
    log(room, `${hunter.name} caught ${target.name}. ${target.name} is now a hunter.`, 'catch');
  }

  if (room.settings.revealOnCatch) reveal(room, 'all');

  const preyLeft = living(room, 'prey').length;
  const huntersLeft = living(room, 'hunter').length;
  if (!preyLeft) endGame(room, 'hunters', 'All prey are caught. Hunters win.');
  else if (!huntersLeft) endGame(room, 'prey', 'No hunters left. Prey win.');
  return null;
}

function tick() {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (now - room.createdAt > ROOM_TTL_MS && ![...room.players.values()].some((p) => p.connected)) {
      rooms.delete(room.code);
      continue;
    }
    let dirty = false;
    if (room.status === 'running') {
      // No time limit, and no reveal until the host has sent the first
      // ping — nextPreyReveal/nextHunterReveal stay null until then.
      if (room.nextPreyReveal && now >= room.nextPreyReveal) {
        reveal(room, 'prey', 'Prey positions revealed.');
        room.nextPreyReveal = now + room.settings.preyRevealSec * 1000;
        dirty = true;
      }
      if (room.nextHunterReveal && now >= room.nextHunterReveal) {
        reveal(room, 'hunter', 'Hunter positions revealed.');
        room.nextHunterReveal = now + room.settings.hunterRevealSec * 1000;
        dirty = true;
      }
    }
    if (dirty || now - room.lastBroadcast > BROADCAST_EVERY_MS) broadcast(room);
  }
}
setInterval(tick, TICK_MS);

// ------------------------------------------------------------- the wire

function viewFor(room, me) {
  const now = Date.now();
  return {
    type: 'state',
    serverNow: now,
    room: {
      code: room.code,
      status: room.status,
      settings: room.settings,
      hostId: room.hostId,
      startedAt: room.startedAt,
      nextPreyReveal: room.nextPreyReveal,
      nextHunterReveal: room.nextHunterReveal,
      lastReveal: room.lastReveal || null,
      outcome: room.outcome,
      log: room.log.slice(0, 12),
      players: [...room.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        alive: p.alive,
        connected: p.connected,
        isHost: p.id === room.hostId,
        isYou: p.id === me.id,
        // Never send a live position. Only what the room has earned.
        shown: p.shown || null,
        prevShown: p.prevShown || null,
      })),
    },
    you: { id: me.id, name: me.name, role: me.role, alive: me.alive, isHost: me.id === room.hostId },
  };
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room) {
  room.lastBroadcast = Date.now();
  for (const client of wss.clients) {
    if (client.roomCode !== room.code) continue;
    const me = room.players.get(client.playerId);
    if (!me) continue;
    send(client, viewFor(room, me));
  }
}

function requireHost(room, player) {
  return room.hostId === player.id ? null : 'Only the host can do that.';
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // --- entry points -----------------------------------------------------
    if (msg.type === 'create') {
      const room = createRoom();
      const player = addPlayer(room, (msg.name || 'Player').trim() || 'Player');
      player.role = 'hunter';
      ws.roomCode = room.code;
      ws.playerId = player.id;
      log(room, `${player.name} opened the room.`);
      send(ws, { type: 'joined', code: room.code, playerId: player.id });
      broadcast(room);
      return;
    }

    if (msg.type === 'join') {
      const room = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!room) return send(ws, { type: 'error', msg: 'No room with that code.' });
      let player = msg.playerId ? room.players.get(msg.playerId) : null;
      if (!player) {
        if (room.players.size >= 40) return send(ws, { type: 'error', msg: 'Room is full.' });
        player = addPlayer(room, (msg.name || 'Player').trim() || 'Player');
        log(room, `${player.name} joined.`);
      } else if (msg.name) {
        player.name = String(msg.name).slice(0, 16);
      }
      player.connected = true;
      ws.roomCode = room.code;
      ws.playerId = player.id;
      send(ws, { type: 'joined', code: room.code, playerId: player.id });
      broadcast(room);
      return;
    }

    // --- everything below needs a seat in a room --------------------------
    const room = rooms.get(ws.roomCode);
    const me = room && room.players.get(ws.playerId);
    if (!room || !me) return send(ws, { type: 'error', msg: 'You are not in a room.' });

    switch (msg.type) {
      case 'loc': {
        const lat = num(msg.lat, null);
        const lng = num(msg.lng, null);
        if (lat === null || lng === null) break;
        me.live = { lat, lng, acc: clamp(num(msg.acc, 0), 0, 5000), at: Date.now() };
        // Deliberately no broadcast: a location update must not leak timing.
        break;
      }

      case 'settings': {
        const err = requireHost(room, me);
        if (err) return send(ws, { type: 'error', msg: err });
        const s = room.settings;
        const inc = msg.settings || {};
        s.preyRevealSec = clamp(Math.round(num(inc.preyRevealSec, s.preyRevealSec)), 15, 3600);
        s.hunterRevealSec = clamp(Math.round(num(inc.hunterRevealSec, s.hunterRevealSec)), 15, 3600);
        if (['convert', 'eliminate', 'swap'].includes(inc.onCatch)) s.onCatch = inc.onCatch;
        if (typeof inc.revealOnCatch === 'boolean') s.revealOnCatch = inc.revealOnCatch;
        broadcast(room);
        break;
      }

      case 'setRole': {
        const err = requireHost(room, me);
        if (err) return send(ws, { type: 'error', msg: err });
        const target = room.players.get(msg.playerId);
        if (target && ['hunter', 'prey'].includes(msg.role)) {
          target.role = msg.role;
          broadcast(room);
        }
        break;
      }

      case 'shuffle': {
        const err = requireHost(room, me);
        if (err) return send(ws, { type: 'error', msg: err });
        const ids = [...room.players.keys()];
        for (let i = ids.length - 1; i > 0; i--) {
          const j = crypto.randomInt(i + 1);
          [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        const hunters = clamp(Math.round(num(msg.hunterCount, 1)), 1, Math.max(1, ids.length - 1));
        ids.forEach((id, i) => { room.players.get(id).role = i < hunters ? 'hunter' : 'prey'; });
        log(room, 'Roles shuffled.');
        broadcast(room);
        break;
      }

      case 'kick': {
        const err = requireHost(room, me);
        if (err) return send(ws, { type: 'error', msg: err });
        const target = room.players.get(msg.playerId);
        if (target && target.id !== room.hostId) {
          room.players.delete(target.id);
          log(room, `${target.name} was removed.`);
          broadcast(room);
        }
        break;
      }

      case 'start': {
        const err = requireHost(room, me);
        if (err) return send(ws, { type: 'error', msg: err });
        const problem = startGame(room);
        if (problem) return send(ws, { type: 'error', msg: problem });
        broadcast(room);
        break;
      }

      case 'revealNow': {
        // Doubles as "send the first ping" (when nothing's scheduled yet)
        // and as a manual early reveal later in the hunt.
        const err = requireHost(room, me);
        if (err) return send(ws, { type: 'error', msg: err });
        if (room.status !== 'running') break;
        const isFirst = !room.nextPreyReveal && !room.nextHunterReveal;
        sendPing(room, isFirst ? `${me.name} sent the first ping.` : `${me.name} called an early ping.`);
        broadcast(room);
        break;
      }

      case 'catch': {
        const problem = declareCatch(room, me, msg.playerId);
        if (problem) return send(ws, { type: 'error', msg: problem });
        broadcast(room);
        break;
      }

      case 'endGame': {
        const err = requireHost(room, me);
        if (err) return send(ws, { type: 'error', msg: err });
        if (room.status === 'running') endGame(room, 'called', 'Host ended the hunt.');
        broadcast(room);
        break;
      }

      case 'backToLobby': {
        const err = requireHost(room, me);
        if (err) return send(ws, { type: 'error', msg: err });
        room.status = 'lobby';
        room.outcome = null;
        room.lastReveal = null;
        for (const p of room.players.values()) {
          p.alive = true;
          p.shown = null;
          p.prevShown = null;
        }
        log(room, 'Back to the lobby.');
        broadcast(room);
        break;
      }

      case 'rename': {
        me.name = String(msg.name || me.name).slice(0, 16);
        broadcast(room);
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    const me = room && room.players.get(ws.playerId);
    if (!room || !me) return;
    me.connected = false;
    if (room.status === 'lobby') {
      // Nobody is invested yet — clean up ghosts, and hand off the room.
      room.players.delete(me.id);
      if (room.hostId === me.id) {
        const next = [...room.players.values()][0];
        room.hostId = next ? next.id : null;
      }
      if (!room.players.size) { rooms.delete(room.code); return; }
    }
    broadcast(room);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`QUARRY running on http://localhost:${PORT}`);
});
