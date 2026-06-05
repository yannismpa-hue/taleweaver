const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const cors       = require('cors');
const mongoose   = require('mongoose');

const app    = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json());

const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// ── CONSTANTS ────────────────────────────────
const PLAYER_COLORS  = ['#e8a045', '#4ecdc4', '#c084fc', '#f87171'];
const PLAYER_EMBLEMS = ['🜁', '🜃', '🜄', '🜂'];
const MAX_PLAYERS    = 4;
const IMAGE_EVERY    = 6;
const JOKER_COOLDOWN = 30;
const LOBBY_TTL_DAYS = 7;
const FIRST_TURN_LIMIT = 500;
const VOTE_TIMEOUT_MS  = 30000;

// ── MONGOOSE SCHEMA ───────────────────────────
const PlayerSchema = new mongoose.Schema({
  id: String, name: String, color: String, emblem: String,
  jokerAvailable: { type: Boolean, default: true },
  jokerLastUsedAt: { type: Number, default: -JOKER_COOLDOWN },
}, { _id: false });

const SegmentSchema = new mongoose.Schema({
  playerId: String, playerName: String, playerColor: String, playerEmblem: String,
  text: String, timestamp: Number,
  usedJoker: { type: Boolean, default: false },
  isAiScene: { type: Boolean, default: false },
}, { _id: false });

const LobbySchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  hostId: String,
  players: [PlayerSchema],
  story: [SegmentSchema],
  wordLimit: Number,
  currentPlayerIndex: Number,
  promptCount: { type: Number, default: 0 },
  status: { type: String, default: 'waiting' },
  currentBackground: String,
  randomScene: { type: Boolean, default: false },
  lastActivity: { type: Date, default: Date.now },
}, { timestamps: true });
LobbySchema.index({ lastActivity: 1 }, { expireAfterSeconds: LOBBY_TTL_DAYS * 86400 });
const LobbyModel = mongoose.models.Lobby || mongoose.model('Lobby', LobbySchema);

// ── DB ────────────────────────────────────────
let isDbConnected = false;
async function connectDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.warn('MONGODB_URI not set — memory-only mode.'); return; }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    isDbConnected = true;
    console.log('✦ MongoDB connected');
  } catch (err) {
    console.error('✘ MongoDB connection failed:', err.message);
    console.warn('  Continuing in memory-only mode.');
  }
}

// ── LOBBY STORE ───────────────────────────────
const lobbies = new Map();
const disconnectTimers = new Map(); // socketId -> timeout handle

// ── HELPERS ───────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function jokerRechargeIn(p, promptCount) {
  if (p.jokerAvailable) return 0;
  return Math.max(0, JOKER_COOLDOWN - (promptCount - p.jokerLastUsedAt));
}

function getVoteState(lobby) {
  if (!lobby.activeVote) return null;
  const v = lobby.activeVote;
  const voters = lobby.players.filter(p => !p.id.startsWith('disconnected:') && p.id !== v.targetId);
  return {
    targetId: v.targetId,
    targetName: v.targetName,
    startedByName: v.startedByName,
    votes: v.votes,
    votedCount: Object.keys(v.votes).length,
    totalVoters: voters.length,
    expiresAt: v.startedAt + VOTE_TIMEOUT_MS,
  };
}

// Advance currentPlayerIndex past any disconnected slots
function advanceToActive(lobby) {
  if (!lobby.players.length) return;
  let safety = 0;
  while (
    lobby.players[lobby.currentPlayerIndex]?.id.startsWith('disconnected:') &&
    safety < lobby.players.length
  ) {
    lobby.currentPlayerIndex = (lobby.currentPlayerIndex + 1) % lobby.players.length;
    safety++;
  }
}

function publicState(lobby) {
  const pc = lobby.promptCount;
  const isFirstTurn = pc === 0 && !lobby.randomScene;
  return {
    code: lobby.code,
    hostId: lobby.hostId,
    wordLimit: lobby.wordLimit,
    currentPlayerIndex: lobby.currentPlayerIndex,
    currentPlayerId: lobby.players[lobby.currentPlayerIndex]?.id ?? null,
    promptCount: pc,
    status: lobby.status,
    currentBackground: lobby.currentBackground,
    nextImageIn: IMAGE_EVERY - (pc % IMAGE_EVERY),
    randomScene: lobby.randomScene,
    firstTurnLimit: isFirstTurn ? FIRST_TURN_LIMIT : null,
    activeVote: getVoteState(lobby),
    players: lobby.players.map(p => ({
      id: p.id, name: p.name, color: p.color, emblem: p.emblem,
      jokerAvailable: p.jokerAvailable,
      jokerRechargeIn: jokerRechargeIn(p, pc),
    })),
    story: lobby.story,
  };
}

function makeImageUrl(story) {
  const text = story.slice(-IMAGE_EVERY).map(s => s.text).join(' ')
    .replace(/[^\w\s,.\-!?']/g, '').substring(0, 350);
  const prompt = encodeURIComponent(`cinematic fantasy concept art, dramatic lighting, ultra-detailed, painterly: ${text}`);
  return `https://image.pollinations.ai/prompt/${prompt}?width=1920&height=1080&nologo=true&seed=${Math.floor(Math.random()*99999)}`;
}

async function generateOpeningScene() {
  try {
    const prompt = encodeURIComponent(
      'Write a dramatic atmospheric opening scene for a collaborative story. ' +
      'Be vivid, specific, and cinematic. End on a hook. 3-4 sentences only. ' +
      'No title, no preamble, no quotation marks. Just the scene.'
    );
    const res = await fetch(`https://text.pollinations.ai/${prompt}?model=openai&seed=${Math.floor(Math.random()*9999)}`);
    if (!res.ok) throw new Error('API error');
    return (await res.text()).trim();
  } catch (err) {
    console.error('Scene generation failed:', err.message);
    const fallbacks = [
      'The last lighthouse keeper on the edge of the known world had not seen another soul in three years — until the night a ship appeared from the fog, flying no flag and carrying no crew.',
      'When the ancient clock in the village square struck thirteen, everyone in the market froze. Everyone except one.',
      'The letter arrived sealed in black wax, addressed to someone who had died fifteen years ago — and somehow delivered to their former home, where a stranger now lived.',
      'Three moons hung in the sky the night the stranger rode into Ashenveil, and not one of the villagers could agree on what colour her eyes had been.',
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
}

async function saveLobby(lobby) {
  if (!isDbConnected) return;
  try {
    const doc = { ...lobby, lastActivity: new Date() };
    delete doc._id;
    await LobbyModel.findOneAndUpdate({ code: lobby.code }, doc, { upsert: true, new: true, lean: true });
  } catch (err) { console.error('DB save error:', err.message); }
}

async function loadLobbyFromDb(code) {
  if (!isDbConnected) return null;
  try {
    const doc = await LobbyModel.findOne({ code, status: { $ne: 'expired' } }).lean();
    if (!doc) return null;
    doc.players = (doc.players || []).map(p => ({
      jokerAvailable: true, jokerLastUsedAt: -JOKER_COOLDOWN, ...p,
    }));
    return doc;
  } catch (err) { console.error('DB load error:', err.message); return null; }
}

async function restoreLobbies() {
  if (!isDbConnected) return;
  try {
    const cutoff = new Date(Date.now() - LOBBY_TTL_DAYS * 86400 * 1000);
    const docs = await LobbyModel.find({ status: { $in: ['waiting','playing'] }, lastActivity: { $gte: cutoff } }).lean();
    for (const doc of docs) {
      doc.players = (doc.players || []).map(p => ({ jokerAvailable: true, jokerLastUsedAt: -JOKER_COOLDOWN, ...p }));
      lobbies.set(doc.code, doc);
    }
    if (docs.length) console.log(`✦ Restored ${docs.length} lobby/lobbies from DB`);
  } catch (err) { console.error('Lobby restore error:', err.message); }
}

function resolveVote(code) {
  const lobby = lobbies.get(code);
  if (!lobby || !lobby.activeVote) return;
  if (lobby.voteTimeout) { clearTimeout(lobby.voteTimeout); lobby.voteTimeout = null; }
  const vote = lobby.activeVote;
  lobby.activeVote = null;
  const voters = lobby.players.filter(p => !p.id.startsWith('disconnected:') && p.id !== vote.targetId);
  const yesVotes = voters.filter(p => vote.votes[p.id] === true).length;
  const passed = yesVotes > voters.length / 2;
  if (passed) {
    const idx = lobby.players.findIndex(p => p.id === vote.targetId);
    if (idx !== -1) lobby.players.splice(idx, 1);
    if (lobby.currentPlayerIndex >= lobby.players.length) lobby.currentPlayerIndex = 0;
    const kicked = io.sockets.sockets.get(vote.targetId);
    if (kicked) { kicked.emit('you-were-kicked', { message: `The scribes have voted to remove you from the story.` }); kicked.leave(code); }
    io.to(code).emit('vote-resolved', { ...publicState(lobby), notice: `${vote.targetName} was removed by vote.` });
  } else {
    io.to(code).emit('vote-resolved', { ...publicState(lobby), notice: `Vote to remove ${vote.targetName} did not pass.` });
  }
  saveLobby(lobby);
}

// ── SOCKET HANDLERS ───────────────────────────
io.on('connection', (socket) => {

  socket.on('create-lobby', async ({ playerName, wordLimit, randomScene }) => {
    const name = playerName?.trim().substring(0, 24);
    if (!name) return socket.emit('err', 'A name is required.');
    let code; do { code = generateCode(); } while (lobbies.has(code));
    const wl = Math.min(Math.max(parseInt(wordLimit) || 20, 5), 100);
    const lobby = {
      code, hostId: socket.id,
      players: [{ id: socket.id, name, color: PLAYER_COLORS[0], emblem: PLAYER_EMBLEMS[0], jokerAvailable: true, jokerLastUsedAt: -JOKER_COOLDOWN }],
      story: [], wordLimit: wl, currentPlayerIndex: 0, promptCount: 0,
      status: 'waiting', currentBackground: null,
      randomScene: !!randomScene, activeVote: null, voteTimeout: null,
    };
    lobbies.set(code, lobby);
    socket.join(code);
    socket.data = { code, name };
    socket.emit('lobby-created', publicState(lobby));
    saveLobby(lobby);
  });

  socket.on('join-lobby', async ({ code, playerName }) => {
    const c    = code?.trim().toUpperCase();
    const name = playerName?.trim().replace(/\s+/g, ' ').substring(0, 24);
    if (!name) return socket.emit('err', 'A name is required.');

    // Normalize for comparison only — preserves original casing in storage
    const norm = (n) => n?.trim().toLowerCase().replace(/\s+/g, ' ') || '';

    let lobby = lobbies.get(c);
    if (!lobby) { lobby = await loadLobbyFromDb(c); if (lobby) lobbies.set(c, lobby); }
    if (!lobby)                    return socket.emit('err', 'Lobby not found. Double-check the code!');
    if (lobby.status === 'expired') return socket.emit('err', 'This lobby has expired.');

    // ── REJOIN CHECK FIRST (before capacity) ──────────────
    // Matches regardless of case or extra spaces
    const existingIdx = lobby.players.findIndex(p => norm(p.name) === norm(name));
    if (existingIdx !== -1) {
      const slot = lobby.players[existingIdx];
      const oldId = slot.id;
      slot.id = socket.id;

      // Restore host if this player was the host before disconnecting
      if (lobby.hostId === oldId || lobby.hostId === `disconnected:${slot.name}`) {
        lobby.hostId = socket.id;
      }

      socket.join(c);
      socket.data = { code: c, name: slot.name }; // keep the stored name

      // Send to the rejoining player first so they know their view
      socket.emit('lobby-joined', publicState(lobby));
      // Blast fresh state to the ENTIRE room (including the rejoiner) so no
      // stale story-updated from another player can overwrite it afterwards
      io.to(c).emit('story-updated', publicState(lobby));
      saveLobby(lobby);
      return;
    }

    // ── NEW PLAYER ────────────────────────────────────────
    if (lobby.players.length >= MAX_PLAYERS) return socket.emit('err', 'The tavern is full (4/4).');
    if (lobby.status !== 'waiting') return socket.emit('err', 'This story has already begun — you cannot join mid-tale.');

    const idx = lobby.players.length;
    lobby.players.push({
      id: socket.id, name,
      color: PLAYER_COLORS[idx], emblem: PLAYER_EMBLEMS[idx],
      jokerAvailable: true, jokerLastUsedAt: -JOKER_COOLDOWN,
    });

    socket.join(c);
    socket.data = { code: c, name };
    socket.emit('lobby-joined', publicState(lobby));
    socket.to(c).emit('lobby-updated', publicState(lobby));
    saveLobby(lobby);
  });

  // ── REJOIN SESSION (automatic reconnect) ─────
  // Called automatically by the client on every socket reconnect.
  // Reclaims an existing player slot without needing host approval.
  socket.on('rejoin-session', async ({ code, name }) => {
    const c    = code?.trim().toUpperCase();
    const norm = (n) => n?.trim().toLowerCase().replace(/\s+/g, ' ') || '';

    let lobby = lobbies.get(c);
    if (!lobby) { lobby = await loadLobbyFromDb(c); if (lobby) lobbies.set(c, lobby); }
    if (!lobby) return; // lobby gone — silently ignore, client stays on current view

    const idx = lobby.players.findIndex(p => norm(p.name) === norm(name));
    if (idx === -1) return; // not in this lobby

    const slot   = lobby.players[idx];
    const oldId  = slot.id;

    // Cancel any pending disconnect timer for this slot
    if (disconnectTimers.has(oldId)) {
      clearTimeout(disconnectTimers.get(oldId));
      disconnectTimers.delete(oldId);
    }

    slot.id = socket.id;

    // Restore host if their slot was the host
    if (lobby.hostId === oldId || lobby.hostId === `disconnected:${slot.name}`) {
      lobby.hostId = socket.id;
    }

    // If their turn was skipped while they were gone, give it back to them
    // by re-advancing to the correct active player
    advanceToActive(lobby);

    socket.join(c);
    socket.data = { code: c, name: slot.name };

    socket.emit('lobby-joined', publicState(lobby));
    socket.to(c).emit('lobby-updated', publicState(lobby));
    saveLobby(lobby);
  });

  socket.on('start-game', async () => {
    const { code } = socket.data ?? {};
    const lobby    = lobbies.get(code);
    if (!lobby) return;
    if (lobby.hostId !== socket.id) return socket.emit('err', 'Only the host may begin the tale.');
    if (lobby.players.length < 2) return socket.emit('err', 'You need at least 2 scribes to start.');
    lobby.status = 'playing';
    if (lobby.randomScene) {
      io.to(code).emit('generating-scene', publicState(lobby));
      const sceneText = await generateOpeningScene();
      lobby.story.push({ playerId: 'ai', playerName: 'The Muse', playerColor: '#c084fc', playerEmblem: '✦', text: sceneText, timestamp: Date.now(), usedJoker: false, isAiScene: true });
      lobby.promptCount++;
      lobby.currentBackground = makeImageUrl(lobby.story);
    }
    io.to(code).emit('game-started', publicState(lobby));
    saveLobby(lobby);
  });

  socket.on('submit-turn', ({ text, useJoker }) => {
    const { code } = socket.data ?? {};
    const lobby = lobbies.get(code);
    if (!lobby || lobby.status !== 'playing') return;
    const active = lobby.players[lobby.currentPlayerIndex];
    if (active?.id !== socket.id) return socket.emit('err', 'It is not your turn, scribe.');
    const trimmed = text?.trim() ?? '';
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length === 0) return socket.emit('err', 'Write something before submitting!');
    const isFirstTurn = lobby.promptCount === 0 && !lobby.randomScene;
    const baseLimit = isFirstTurn ? FIRST_TURN_LIMIT : lobby.wordLimit;
    const jokerWanted = useJoker && active.jokerAvailable && !isFirstTurn;
    const effectiveLimit = jokerWanted ? baseLimit * 2 : baseLimit;
    if (words.length > effectiveLimit) return socket.emit('err', `Too many words! Limit is ${effectiveLimit}.`);
    if (jokerWanted) { active.jokerAvailable = false; active.jokerLastUsedAt = lobby.promptCount; }
    lobby.story.push({ playerId: socket.id, playerName: active.name, playerColor: active.color, playerEmblem: active.emblem, text: trimmed, timestamp: Date.now(), usedJoker: jokerWanted });
    lobby.promptCount++;
    lobby.currentPlayerIndex = (lobby.currentPlayerIndex + 1) % lobby.players.length;
    for (const p of lobby.players) {
      if (!p.jokerAvailable && (lobby.promptCount - p.jokerLastUsedAt) >= JOKER_COOLDOWN) p.jokerAvailable = true;
    }
    if (lobby.promptCount % IMAGE_EVERY === 0) lobby.currentBackground = makeImageUrl(lobby.story);
    io.to(code).emit('story-updated', publicState(lobby));
    saveLobby(lobby);
  });

  socket.on('skip-turn', () => {
    const { code } = socket.data ?? {};
    const lobby = lobbies.get(code);
    if (!lobby || lobby.status !== 'playing') return;
    const active = lobby.players[lobby.currentPlayerIndex];
    if (active?.id !== socket.id) return socket.emit('err', 'It is not your turn.');
    const skipperName = active.name;
    lobby.currentPlayerIndex = (lobby.currentPlayerIndex + 1) % lobby.players.length;
    io.to(code).emit('turn-skipped', { ...publicState(lobby), notice: `${skipperName} passed their turn.` });
    saveLobby(lobby);
  });

  socket.on('initiate-vote-kick', ({ targetId }) => {
    const { code } = socket.data ?? {};
    const lobby = lobbies.get(code);
    if (!lobby || lobby.status !== 'playing') return;
    if (lobby.activeVote) return socket.emit('err', 'A vote is already in progress.');
    const target = lobby.players.find(p => p.id === targetId);
    if (!target) return socket.emit('err', 'Player not found.');
    if (targetId === socket.id) return socket.emit('err', "You can't vote to kick yourself.");
    const me = lobby.players.find(p => p.id === socket.id);
    lobby.activeVote = { targetId, targetName: target.name, startedByName: me?.name, votes: { [socket.id]: true }, startedAt: Date.now() };
    lobby.voteTimeout = setTimeout(() => resolveVote(code), VOTE_TIMEOUT_MS);
    io.to(code).emit('vote-started', { ...publicState(lobby), notice: `${me?.name} called a vote to remove ${target.name}.` });
  });

  socket.on('cast-vote', ({ approve }) => {
    const { code } = socket.data ?? {};
    const lobby = lobbies.get(code);
    if (!lobby || !lobby.activeVote) return;
    if (socket.id === lobby.activeVote.targetId) return;
    lobby.activeVote.votes[socket.id] = approve;
    const voters = lobby.players.filter(p => !p.id.startsWith('disconnected:') && p.id !== lobby.activeVote.targetId);
    const allVoted = voters.every(p => lobby.activeVote.votes[p.id] !== undefined);
    if (allVoted) resolveVote(code);
    else io.to(code).emit('vote-updated', publicState(lobby));
  });

  socket.on('disconnect', () => {
    const { code } = socket.data ?? {};
    if (!code) return;
    const lobby = lobbies.get(code);
    if (!lobby) return;
    const idx = lobby.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    const leavingName = lobby.players[idx].name;

    // Give the player 20 seconds to reconnect before marking them as gone.
    // Socket.io reconnects automatically on mobile/unstable connections,
    // and the client sends rejoin-session on reconnect — so this timer
    // usually gets cancelled before it fires.
    const timer = setTimeout(() => {
      disconnectTimers.delete(socket.id);
      const lobby = lobbies.get(code);
      if (!lobby) return;
      const p = lobby.players.find(p => p.id === socket.id);
      if (!p) return; // already reclaimed by rejoin-session

      p.id = `disconnected:${leavingName}`;

      const active = lobby.players.filter(p => !p.id.startsWith('disconnected:'));
      if (active.length === 0) {
        setTimeout(() => {
          const l = lobbies.get(code);
          if (l && l.players.every(p => p.id.startsWith('disconnected:'))) lobbies.delete(code);
        }, 600000);
        return;
      }

      if (lobby.hostId === socket.id) lobby.hostId = active[0].id;
      advanceToActive(lobby);

      io.to(code).emit('player-left', {
        ...publicState(lobby),
        notice: `${leavingName} vanished into the mist…`,
      });
      saveLobby(lobby);
    }, 20000);

    disconnectTimers.set(socket.id, timer);
  });
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(dist));
  app.get('*', (_, res) => res.sendFile(path.join(dist, 'index.html')));
}

const PORT = process.env.PORT || 3001;
(async () => {
  await connectDb();
  await restoreLobbies();
  server.listen(PORT, () => console.log(`✦ TaleWeaver server running on :${PORT}`));
})();
