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

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────
const PLAYER_COLORS  = ['#e8a045', '#4ecdc4', '#c084fc', '#f87171'];
const PLAYER_EMBLEMS = ['🜁', '🜃', '🜄', '🜂'];
const MAX_PLAYERS    = 4;
const IMAGE_EVERY    = 6;
const JOKER_COOLDOWN = 30;   // story entries before joker recharges
const LOBBY_TTL_DAYS = 7;    // auto-expire old lobbies

// ─────────────────────────────────────────────
//  MONGODB SCHEMA
// ─────────────────────────────────────────────
const PlayerSchema = new mongoose.Schema({
  id:               String,
  name:             String,
  color:            String,
  emblem:           String,
  jokerAvailable:   { type: Boolean, default: true },
  jokerLastUsedAt:  { type: Number,  default: -JOKER_COOLDOWN },
}, { _id: false });

const SegmentSchema = new mongoose.Schema({
  playerId:    String,
  playerName:  String,
  playerColor: String,
  playerEmblem:String,
  text:        String,
  timestamp:   Number,
  usedJoker:   { type: Boolean, default: false },
}, { _id: false });

const LobbySchema = new mongoose.Schema({
  code:               { type: String, required: true, unique: true, index: true },
  hostId:             String,
  players:            [PlayerSchema],
  story:              [SegmentSchema],
  wordLimit:          Number,
  currentPlayerIndex: Number,
  promptCount:        { type: Number, default: 0 },
  status:             { type: String, default: 'waiting' },
  currentBackground:  String,
  lastActivity:       { type: Date, default: Date.now },
}, { timestamps: true });

// TTL index: MongoDB will auto-delete documents after LOBBY_TTL_DAYS days of inactivity
LobbySchema.index({ lastActivity: 1 }, { expireAfterSeconds: LOBBY_TTL_DAYS * 86400 });

const LobbyModel = mongoose.models.Lobby || mongoose.model('Lobby', LobbySchema);

// ─────────────────────────────────────────────
//  DATABASE CONNECTION
// ─────────────────────────────────────────────
let isDbConnected = false;

async function connectDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('⚠  MONGODB_URI not set — running in memory-only mode (stories will not persist).');
    return;
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    isDbConnected = true;
    console.log('✦ MongoDB connected');
  } catch (err) {
    console.error('✘ MongoDB connection failed:', err.message);
    console.warn('  Continuing in memory-only mode.');
  }
}

// ─────────────────────────────────────────────
//  IN-MEMORY LOBBY STORE  { code -> lobby }
// ─────────────────────────────────────────────
const lobbies = new Map();

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function jokerRechargeIn(player, promptCount) {
  if (player.jokerAvailable) return 0;
  return Math.max(0, JOKER_COOLDOWN - (promptCount - player.jokerLastUsedAt));
}

function publicState(lobby) {
  return {
    code:               lobby.code,
    hostId:             lobby.hostId,
    wordLimit:          lobby.wordLimit,
    currentPlayerIndex: lobby.currentPlayerIndex,
    currentPlayerId:    lobby.players[lobby.currentPlayerIndex]?.id ?? null,
    promptCount:        lobby.promptCount,
    status:             lobby.status,
    currentBackground:  lobby.currentBackground,
    nextImageIn:        IMAGE_EVERY - (lobby.promptCount % IMAGE_EVERY),
    players: lobby.players.map(p => ({
      id:              p.id,
      name:            p.name,
      color:           p.color,
      emblem:          p.emblem,
      jokerAvailable:  p.jokerAvailable,
      jokerRechargeIn: jokerRechargeIn(p, lobby.promptCount),
    })),
    story: lobby.story,
  };
}

function makeImageUrl(story) {
  const text = story
    .slice(-IMAGE_EVERY)
    .map(s => s.text)
    .join(' ')
    .replace(/[^\w\s,.\-!?']/g, '')
    .substring(0, 350);
  const prompt  = encodeURIComponent(`cinematic fantasy concept art, dramatic lighting, ultra-detailed, painterly: ${text}`);
  const seed    = Math.floor(Math.random() * 99999);
  return `https://image.pollinations.ai/prompt/${prompt}?width=1920&height=1080&nologo=true&seed=${seed}`;
}

// Persist a lobby to MongoDB (fire-and-forget, errors are non-fatal)
async function saveLobby(lobby) {
  if (!isDbConnected) return;
  try {
    const doc = { ...lobby, lastActivity: new Date() };
    delete doc._id; // avoid immutable field conflict on upsert
    await LobbyModel.findOneAndUpdate(
      { code: lobby.code },
      doc,
      { upsert: true, new: true, lean: true }
    );
  } catch (err) {
    console.error('DB save error:', err.message);
  }
}

// Load a lobby from MongoDB into memory (for reconnects after empty lobby)
async function loadLobbyFromDb(code) {
  if (!isDbConnected) return null;
  try {
    const doc = await LobbyModel.findOne({ code, status: { $ne: 'expired' } }).lean();
    if (!doc) return null;
    // Ensure joker defaults exist for old records
    doc.players = (doc.players || []).map(p => ({
      jokerAvailable:  true,
      jokerLastUsedAt: -JOKER_COOLDOWN,
      ...p,
    }));
    return doc;
  } catch (err) {
    console.error('DB load error:', err.message);
    return null;
  }
}

// On startup: load recent active lobbies into memory
async function restoreLobbies() {
  if (!isDbConnected) return;
  try {
    const cutoff = new Date(Date.now() - LOBBY_TTL_DAYS * 86400 * 1000);
    const docs   = await LobbyModel.find({
      status:       { $in: ['waiting', 'playing'] },
      lastActivity: { $gte: cutoff },
    }).lean();
    for (const doc of docs) {
      doc.players = (doc.players || []).map(p => ({
        jokerAvailable:  true,
        jokerLastUsedAt: -JOKER_COOLDOWN,
        ...p,
      }));
      lobbies.set(doc.code, doc);
    }
    if (docs.length) console.log(`✦ Restored ${docs.length} lobby/lobbies from DB`);
  } catch (err) {
    console.error('Lobby restore error:', err.message);
  }
}

// ─────────────────────────────────────────────
//  SOCKET HANDLERS
// ─────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── CREATE LOBBY ──────────────────────────
  socket.on('create-lobby', async ({ playerName, wordLimit }) => {
    const name = playerName?.trim().substring(0, 24);
    if (!name) return socket.emit('err', 'A name is required.');

    let code;
    do { code = generateCode(); } while (lobbies.has(code));

    const wl = Math.min(Math.max(parseInt(wordLimit) || 20, 5), 100);

    const lobby = {
      code,
      hostId:             socket.id,
      players:            [{
        id: socket.id, name, color: PLAYER_COLORS[0], emblem: PLAYER_EMBLEMS[0],
        jokerAvailable: true, jokerLastUsedAt: -JOKER_COOLDOWN,
      }],
      story:              [],
      wordLimit:          wl,
      currentPlayerIndex: 0,
      promptCount:        0,
      status:             'waiting',
      currentBackground:  null,
    };

    lobbies.set(code, lobby);
    socket.join(code);
    socket.data = { code, name };

    socket.emit('lobby-created', publicState(lobby));
    saveLobby(lobby);
  });

  // ── JOIN LOBBY ────────────────────────────
  socket.on('join-lobby', async ({ code, playerName }) => {
    const c    = code?.trim().toUpperCase();
    const name = playerName?.trim().substring(0, 24);
    if (!name) return socket.emit('err', 'A name is required.');

    // Load from DB if not in memory (handles rejoins after server restart)
    let lobby = lobbies.get(c);
    if (!lobby) {
      lobby = await loadLobbyFromDb(c);
      if (lobby) lobbies.set(c, lobby);
    }

    if (!lobby)                              return socket.emit('err', 'Lobby not found. Double-check the code!');
    if (lobby.status === 'expired')          return socket.emit('err', 'This lobby has expired.');
    if (lobby.players.length >= MAX_PLAYERS) return socket.emit('err', 'The tavern is full (4/4).');

    // Re-join: if a player with the same name is already in the lobby (disconnected),
    // take over that slot so they keep their joker state and color.
    const existingIdx = lobby.players.findIndex(p => p.name === name);
    if (existingIdx !== -1) {
      lobby.players[existingIdx].id = socket.id;
      if (lobby.hostId === 'disconnected' || !lobby.players.some(p => p.id === lobby.hostId)) {
        lobby.hostId = socket.id;
      }
      socket.join(c);
      socket.data = { code: c, name };
      socket.emit('lobby-joined', publicState(lobby));
      socket.to(c).emit('lobby-updated', publicState(lobby));
      saveLobby(lobby);
      return;
    }

    if (lobby.status !== 'waiting') return socket.emit('err', 'This story has already begun — you cannot join mid-tale.');

    const idx = lobby.players.length;
    lobby.players.push({
      id: socket.id, name,
      color:           PLAYER_COLORS[idx],
      emblem:          PLAYER_EMBLEMS[idx],
      jokerAvailable:  true,
      jokerLastUsedAt: -JOKER_COOLDOWN,
    });

    socket.join(c);
    socket.data = { code: c, name };

    socket.emit('lobby-joined', publicState(lobby));
    socket.to(c).emit('lobby-updated', publicState(lobby));
    saveLobby(lobby);
  });

  // ── START GAME ────────────────────────────
  socket.on('start-game', () => {
    const { code } = socket.data ?? {};
    const lobby    = lobbies.get(code);
    if (!lobby) return;
    if (lobby.hostId !== socket.id) return socket.emit('err', 'Only the host may begin the tale.');
    if (lobby.players.length < 2)   return socket.emit('err', 'You need at least 2 scribes to start.');

    lobby.status = 'playing';
    io.to(code).emit('game-started', publicState(lobby));
    saveLobby(lobby);
  });

  // ── SUBMIT TURN ───────────────────────────
  socket.on('submit-turn', ({ text, useJoker }) => {
    const { code } = socket.data ?? {};
    const lobby    = lobbies.get(code);
    if (!lobby || lobby.status !== 'playing') return;

    const active = lobby.players[lobby.currentPlayerIndex];
    if (active?.id !== socket.id) return socket.emit('err', 'It is not your turn, scribe.');

    const trimmed = text?.trim() ?? '';
    const words   = trimmed.split(/\s+/).filter(Boolean);
    if (words.length === 0) return socket.emit('err', 'Write something before submitting!');

    // Resolve joker
    const jokerWanted = useJoker && active.jokerAvailable;
    const effectiveLimit = jokerWanted ? lobby.wordLimit * 2 : lobby.wordLimit;

    if (words.length > effectiveLimit) {
      const hint = jokerWanted
        ? `Even with the Joker, your limit is ${effectiveLimit} words.`
        : `Too many words! Your limit is ${lobby.wordLimit}.`;
      return socket.emit('err', hint);
    }

    // Consume joker
    if (jokerWanted) {
      active.jokerAvailable  = false;
      active.jokerLastUsedAt = lobby.promptCount;
    }

    lobby.story.push({
      playerId:     socket.id,
      playerName:   active.name,
      playerColor:  active.color,
      playerEmblem: active.emblem,
      text:         trimmed,
      timestamp:    Date.now(),
      usedJoker:    jokerWanted,
    });

    lobby.promptCount++;
    lobby.currentPlayerIndex = (lobby.currentPlayerIndex + 1) % lobby.players.length;

    // Recharge any jokers that have cooled down
    for (const p of lobby.players) {
      if (!p.jokerAvailable && (lobby.promptCount - p.jokerLastUsedAt) >= JOKER_COOLDOWN) {
        p.jokerAvailable = true;
      }
    }

    // Refresh background every IMAGE_EVERY turns
    if (lobby.promptCount % IMAGE_EVERY === 0) {
      lobby.currentBackground = makeImageUrl(lobby.story);
    }

    io.to(code).emit('story-updated', publicState(lobby));
    saveLobby(lobby);
  });

  // ── DISCONNECT ────────────────────────────
  socket.on('disconnect', () => {
    const { code } = socket.data ?? {};
    if (!code) return;
    const lobby = lobbies.get(code);
    if (!lobby) return;

    const leavingIdx = lobby.players.findIndex(p => p.id === socket.id);
    if (leavingIdx === -1) return;

    const leavingName = lobby.players[leavingIdx].name;

    // Instead of removing, mark the player slot as disconnected so they can rejoin
    lobby.players[leavingIdx].id = `disconnected:${leavingName}`;

    // Remove if all players are disconnected
    const activePlayers = lobby.players.filter(p => !p.id.startsWith('disconnected:'));
    if (activePlayers.length === 0) {
      // Keep in DB for potential rejoins; remove from memory after delay
      setTimeout(() => {
        const l = lobbies.get(code);
        if (l && l.players.every(p => p.id.startsWith('disconnected:'))) {
          lobbies.delete(code);
        }
      }, 10 * 60 * 1000); // 10 min grace period in memory
      return;
    }

    // Transfer host if needed
    if (lobby.hostId === socket.id) {
      lobby.hostId = activePlayers[0].id;
    }

    // Fix turn index if needed
    while (
      lobby.currentPlayerIndex < lobby.players.length &&
      lobby.players[lobby.currentPlayerIndex].id.startsWith('disconnected:')
    ) {
      lobby.currentPlayerIndex = (lobby.currentPlayerIndex + 1) % lobby.players.length;
    }

    io.to(code).emit('player-left', {
      ...publicState(lobby),
      notice: `${leavingName} vanished into the mist…`,
    });
    saveLobby(lobby);
  });
});

// ─────────────────────────────────────────────
//  SERVE CLIENT IN PRODUCTION
// ─────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const dist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(dist));
  app.get('*', (_, res) => res.sendFile(path.join(dist, 'index.html')));
}

// ─────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

(async () => {
  await connectDb();
  await restoreLobbies();
  server.listen(PORT, () => console.log(`✦ TaleWeaver server running on :${PORT}`));
})();
