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

// ══════════════════════════════════════════════════════════════════════
//  CUSTOMISE THE MUSE & AI PLAYER
//  Edit the strings below to change how the AI behaves in your game.
//  Redeploy (push to GitHub) for changes to take effect.
// ══════════════════════════════════════════════════════════════════════

const MUSE_SCENE_PROMPT =
  'Write a vivid atmospheric opening scene for a collaborative story. ' +
  '4-5 sentences. Be dramatic and specific — establish the setting, mood, and a ' +
  'character or intriguing situation. End on a hook that the next writer can ' +
  'naturally continue from. Write only the scene itself, no title or preamble.';

const AI_PLAYER_SYSTEM_PROMPT =
  'You are a skilled collaborative author contributing to a shared story. ' +
  'Write only your continuation passage — pure narrative prose, no labels, ' +
  'no meta-commentary, no title, no preamble. ' +
  'Match the tone and genre the other writers have established. ' +
  'Advance the plot naturally with vivid detail. ' +
  'Do not undo or contradict what previous writers have written.';

// ══════════════════════════════════════════════════════════════════════
//  DEFAULT SETTINGS  (overridden per-lobby by host sliders)
// ══════════════════════════════════════════════════════════════════════
const DEFAULT_IMAGE_EVERY    = 6;
const DEFAULT_JOKER_COOLDOWN = 30;
const MAX_PLAYERS   = 4;     // human players only
const FIRST_TURN_LIMIT = 500;
const VOTE_TIMEOUT_MS  = 30000;
const LOBBY_TTL_DAYS   = 7;

// ── MONGOOSE SCHEMA ───────────────────────────────────────────────────
const PlayerSchema = new mongoose.Schema({
  id: String, name: String, color: String, emblem: String,
  jokerAvailable:  { type: Boolean, default: true },
  jokerLastUsedAt: { type: Number,  default: 0 },
  isAiPlayer:      { type: Boolean, default: false },
}, { _id: false });

const SegmentSchema = new mongoose.Schema({
  playerId: String, playerName: String, playerColor: String, playerEmblem: String,
  text: String, timestamp: Number,
  usedJoker:  { type: Boolean, default: false },
  isAiScene:  { type: Boolean, default: false },
  isAiTurn:   { type: Boolean, default: false },
}, { _id: false });

const LobbySchema = new mongoose.Schema({
  code:               { type: String, required: true, unique: true, index: true },
  hostId:             String,
  players:            [PlayerSchema],
  story:              [SegmentSchema],
  wordLimit:          { type: Number, default: 20 },
  imageEvery:         { type: Number, default: DEFAULT_IMAGE_EVERY },
  jokerCooldown:      { type: Number, default: DEFAULT_JOKER_COOLDOWN },
  currentPlayerIndex: { type: Number, default: 0 },
  promptCount:        { type: Number, default: 0 },
  status:             { type: String, default: 'waiting' },
  currentBackground:  String,
  randomScene:        { type: Boolean, default: false },
  hasAiPlayer:        { type: Boolean, default: false },
  lastActivity:       { type: Date, default: Date.now },
}, { timestamps: true });
LobbySchema.index({ lastActivity: 1 }, { expireAfterSeconds: LOBBY_TTL_DAYS * 86400 });
const LobbyModel = mongoose.models.Lobby || mongoose.model('Lobby', LobbySchema);

// ── DB ────────────────────────────────────────────────────────────────
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

// ── LOBBY + TIMER STORES ──────────────────────────────────────────────
const lobbies          = new Map();
const disconnectTimers = new Map();

// ── HELPERS ───────────────────────────────────────────────────────────
const PLAYER_COLORS  = ['#e8a045', '#4ecdc4', '#c084fc', '#f87171'];
const PLAYER_EMBLEMS = ['🜁', '🜃', '🜄', '🜂'];
const AI_PLAYER = {
  id: 'ai-player', name: 'The Oracle',
  color: '#a78bfa', emblem: '✦',
  jokerAvailable: false, jokerLastUsedAt: 0, isAiPlayer: true,
};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = ''; for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random()*chars.length)]; return c;
}

function norm(n) { return n?.trim().toLowerCase().replace(/\s+/g,' ') || ''; }

function jokerRechargeIn(p, promptCount, cooldown) {
  if (p.jokerAvailable || p.isAiPlayer) return 0;
  return Math.max(0, cooldown - (promptCount - p.jokerLastUsedAt));
}

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

function getVoteState(lobby) {
  if (!lobby.activeVote) return null;
  const v = lobby.activeVote;
  const voters = lobby.players.filter(p =>
    !p.id.startsWith('disconnected:') && p.id !== v.targetId && !p.isAiPlayer
  );
  return {
    targetId: v.targetId, targetName: v.targetName,
    startedByName: v.startedByName, votes: v.votes,
    votedCount: Object.keys(v.votes).length,
    totalVoters: voters.length,
    expiresAt: v.startedAt + VOTE_TIMEOUT_MS,
  };
}

function publicState(lobby) {
  const pc = lobby.promptCount;
  const ie = lobby.imageEvery || DEFAULT_IMAGE_EVERY;
  const jc = lobby.jokerCooldown || DEFAULT_JOKER_COOLDOWN;
  const isFirstTurn = pc === 0 && !lobby.randomScene;
  return {
    code: lobby.code, hostId: lobby.hostId,
    wordLimit: lobby.wordLimit, imageEvery: ie, jokerCooldown: jc,
    currentPlayerIndex: lobby.currentPlayerIndex,
    currentPlayerId: lobby.players[lobby.currentPlayerIndex]?.id ?? null,
    promptCount: pc, status: lobby.status,
    currentBackground: lobby.currentBackground,
    nextImageIn: ie - (pc % ie),
    randomScene: lobby.randomScene, hasAiPlayer: lobby.hasAiPlayer,
    firstTurnLimit: isFirstTurn ? FIRST_TURN_LIMIT : null,
    activeVote: getVoteState(lobby),
    players: lobby.players.map(p => ({
      id: p.id, name: p.name, color: p.color, emblem: p.emblem,
      jokerAvailable: p.jokerAvailable, isAiPlayer: !!p.isAiPlayer,
      jokerRechargeIn: jokerRechargeIn(p, pc, jc),
    })),
    story: lobby.story,
  };
}

// ── GEMINI API (Google AI Studio) ─────────────────────────────────────
// Keys stored as GEMINI_API_KEY_1 and GEMINI_API_KEY_2 in Render env vars.
// On 429 (rate limit): tries the other key with the same model.
// On any other failure: moves to next model immediately (not next key).
// This prevents hammering both models simultaneously.
const GEMINI_TEXT_MODELS = [
  'gemini-3.5-flash',   // confirmed free tier June 2026
];

// Safety settings loosened so story content isn't blocked
const GEMINI_SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH',        threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',  threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',  threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
];

async function callGemini(prompt, maxTokens = 400) {
  const keys = [process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2].filter(Boolean);
  if (!keys.length) return null;

  for (const model of GEMINI_TEXT_MODELS) {
    let succeeded = false;
    for (const key of keys) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents:         [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: maxTokens, temperature: 0.9 },
              safetySettings:   GEMINI_SAFETY,
            }),
            signal: AbortSignal.timeout(30000),
          }
        );
        const data = await res.json();

        if (res.status === 429) {
          // Rate limited on this key — try the other key with the same model
          console.warn(`${model} rate limited (key), trying other key…`);
          continue;
        }

        if (!res.ok) {
          // Hard error on this model (e.g. model not found, auth error)
          console.warn(`${model} HTTP ${res.status}:`, JSON.stringify(data).substring(0, 150));
          break; // skip remaining keys, try next model
        }

        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text && text.length > 10) {
          console.log(`✦ Gemini text OK (${model})`);
          succeeded = true;
          return text;
        }

        // Empty or safety-blocked response
        const reason = data?.candidates?.[0]?.finishReason || 'unknown';
        console.warn(`${model} empty/blocked (${reason}):`, JSON.stringify(data).substring(0, 200));
        break; // skip remaining keys, try next model

      } catch (err) {
        console.error(`${model} exception:`, err.message);
        break; // network/timeout — skip to next model
      }
    }
    if (succeeded) break;
  }
  return null;
}

// ── BACKGROUND IMAGE GENERATION ─────────────────────────────────────────
// Uses gemini-2.5-flash-image (free tier, up to 500/day via generateContent).
// imagen-4.0-* requires a paid plan — do NOT use it with free AI Studio keys.
// Falls back to Pollinations if the Gemini image call fails.
const IMAGEN_MODELS = [
  'gemini-2.5-flash-image',   // free tier, "Nano Banana" — 500 req/day
];

async function generateBackground(story, imageEvery) {
  const n       = imageEvery || DEFAULT_IMAGE_EVERY;
  const rawText = story.slice(-n).map(s => s.text).join(' ');
  const text    = rawText.replace(/[^\w\s,.\'\-!?"]/g, '')
                         .replace(/\s+/g, ' ').trim().substring(0, 200);
  if (!text) return null;

  const prompt =
    'Generate a wide cinematic background painting — atmospheric, dramatic lighting, ' +
    `highly detailed. Scene: ${text}`;
  console.log('✦ Image prompt:', prompt.substring(0, 100) + '…');

  const keys = [process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2].filter(Boolean);

  for (const model of IMAGEN_MODELS) {
    for (const key of keys) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents:       [{ parts: [{ text: prompt }] }],
              generationConfig: { responseModalities: ['image', 'text'] },
            }),
            signal: AbortSignal.timeout(60000),
          }
        );

        const body = await res.text();
        if (res.status === 429) { console.warn(`${model} rate limited, trying next key…`); continue; }
        if (!res.ok) {
          console.warn(`${model} HTTP ${res.status}:`, body.substring(0, 200));
          break;
        }

        let data;
        try { data = JSON.parse(body); } catch (e) { console.warn('JSON parse failed'); break; }

        // Response: candidates[0].content.parts[] — find the part with inline_data
        const parts = data?.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part.inline_data?.data) {
            const mime = part.inline_data.mimeType || 'image/png';
            console.log(`✦ Image OK (${model}, ~${Math.round(part.inline_data.data.length / 1024)}KB b64)`);
            return `data:${mime};base64,${part.inline_data.data}`;
          }
        }

        // Got a response but no image — log to diagnose
        const reason = data?.candidates?.[0]?.finishReason;
        console.warn(`${model} — no image in response. finishReason: ${reason}`);
        console.warn('Parts received:', parts.map(p => Object.keys(p)).join(', '));
        break;

      } catch (err) {
        console.error(`${model} exception:`, err.message);
        break;
      }
    }
  }

  // ── Pollinations fallback ─────────────────────────────────────────────
  const encoded = encodeURIComponent(`atmospheric cinematic painting, dramatic lighting: ${text}`);
  const seed    = Math.floor(Math.random() * 99999);
  const url     = `https://image.pollinations.ai/prompt/${encoded}?width=1280&height=720&nologo=true&seed=${seed}&model=flux`;
  console.log('✦ Falling back to Pollinations');
  return url;
}

async function generateOpeningScene() {
  // 1 — Gemini
  const aiText = await callGemini(MUSE_SCENE_PROMPT, 400);
  if (aiText) return aiText;

  // 2 — Pollinations text (free, no key)
  try {
    const res = await fetch(
      `https://text.pollinations.ai/${encodeURIComponent(MUSE_SCENE_PROMPT)}?model=openai&seed=${Date.now()%99999}`,
      { signal: AbortSignal.timeout(12000) }
    );
    if (res.ok) {
      const t = (await res.text()).trim();
      if (t.length > 60) { console.log('✦ Scene via Pollinations text'); return t; }
    }
  } catch (err) { console.error('Pollinations text failed:', err.message); }

  // 3 — Rich built-in fallbacks
  console.log('✦ Using built-in fallback scene');
  const fallbacks = [
    'The city of Velmoor had not seen rain in three years, and when the storm clouds gathered on the eve of the Solstice every street-lamp extinguished itself at once. In the sudden darkness a lone figure crossed the empty central plaza, crouching beside the old fountain to retrieve something wrapped in black cloth that had certainly not been there a moment before. From the guard tower above, the watch captain saw her look directly at him — and smile. Then the first drop fell.',
    'The submarine had sat on the ocean floor for forty-seven years before its distress beacon activated. Dr. Reyes was first down the dive line expecting wreckage; instead the forward hatch swung open from the inside. The man who emerged wore a 1977 navy uniform, showed no signs of age, and asked very calmly whether they had won the war. Through the open hatch behind him came the sound of a typewriter still in use.',
    'Everyone in the village of Ashkeld woke that morning with the same dream: a red door at the edge of the forest that had never stood there before, slightly ajar. By noon, three people had gone to look at it. By sunset only two had returned — and they refused to speak about the third, about what they had seen, or about why their shadows now fell in the wrong direction.',
    'The last train out of Caerwyn was supposed to be empty; the whole town had evacuated two days prior. So when the conductor found a single lit compartment at the rear — occupied by a woman reading a newspaper dated six months in the future — he did the only reasonable thing and sat down across from her. She looked up, folded the paper, and said: "You are exactly the person I have been waiting for. We have about eleven minutes before the bridge."',
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

// ── AI PLAYER TURN ────────────────────────────────────────────────────
async function generateAiTurn(code) {
  await new Promise(r => setTimeout(r, 1200 + Math.random() * 1800)); // 1.2-3s "thinking" delay

  const lobby = lobbies.get(code);
  if (!lobby || lobby.status !== 'playing') return;
  if (lobby.players[lobby.currentPlayerIndex]?.id !== 'ai-player') return;

  const isFirst = lobby.promptCount === 0 && !lobby.randomScene;
  const wl      = isFirst ? FIRST_TURN_LIMIT : lobby.wordLimit;

  const recentStory = lobby.story.slice(-8)
    .map(s => `${s.playerName}: "${s.text}"`).join('\n') || '(story just started)';

  const prompt =
    AI_PLAYER_SYSTEM_PROMPT + '\n\n' +
    `Story so far:\n${recentStory}\n\n` +
    (isFirst
      ? `Open the story with a vivid ${wl}-word scene. Establish the setting, mood, and a character. End on a hook.`
      : `Continue the story in ${wl} words or fewer. Move it forward in a surprising direction.`) +
    '\n\nWrite ONLY the continuation text. No labels, no quotation marks wrapping the whole thing.';

  const raw = await callGemini(prompt, Math.max(300, Math.ceil(wl * 5)));

  // Re-fetch lobby in case state changed while waiting for Gemini
  const currentLobby = lobbies.get(code);
  if (!currentLobby || currentLobby.status !== 'playing') return;
  if (currentLobby.players[currentLobby.currentPlayerIndex]?.id !== 'ai-player') return;

  // Trim to word limit
  const aiText = raw
    ? raw.split(/\s+/).slice(0, wl).join(' ')
    : '…'; // silent failure fallback

  const aiPlayer = currentLobby.players[currentLobby.currentPlayerIndex];
  currentLobby.story.push({
    playerId:    'ai-player',
    playerName:  aiPlayer.name,
    playerColor: aiPlayer.color,
    playerEmblem:aiPlayer.emblem,
    text:        aiText,
    timestamp:   Date.now(),
    usedJoker:   false,
    isAiTurn:    true,
  });

  currentLobby.promptCount++;
  currentLobby.currentPlayerIndex =
    (currentLobby.currentPlayerIndex + 1) % currentLobby.players.length;

  const jc = currentLobby.jokerCooldown || DEFAULT_JOKER_COOLDOWN;
  for (const p of currentLobby.players) {
    if (!p.jokerAvailable && !p.isAiPlayer &&
        (currentLobby.promptCount - p.jokerLastUsedAt) >= jc) {
      p.jokerAvailable = true;
    }
  }

  const ie = currentLobby.imageEvery || DEFAULT_IMAGE_EVERY;
  if (currentLobby.promptCount % ie === 0) {
    triggerBackground(code, currentLobby.story, ie);
  }

  advanceToActive(currentLobby);
  io.to(code).emit('story-updated', publicState(currentLobby));
  saveLobby(currentLobby);
}


// Fire-and-forget background generation — generates async, then emits background-updated
function triggerBackground(code, story, imageEvery) {
  const snap = [...story]; // snapshot so mutations don't affect in-flight generation
  generateBackground(snap, imageEvery)
    .then(bgUrl => {
      if (!bgUrl) return;
      const lobby = lobbies.get(code);
      if (!lobby) return;
      lobby.currentBackground = bgUrl;
      io.to(code).emit('background-updated', { currentBackground: bgUrl });
      saveLobby(lobby);
    })
    .catch(err => console.error('Background generation error:', err.message));
}

// ── DB HELPERS ────────────────────────────────────────────────────────
async function saveLobby(lobby) {
  if (!isDbConnected) return;
  try {
    const doc = { ...lobby, lastActivity: new Date() };
    delete doc._id;
    await LobbyModel.findOneAndUpdate({ code: lobby.code }, doc,
      { upsert: true, new: true, lean: true });
  } catch (err) { console.error('DB save error:', err.message); }
}

async function loadLobbyFromDb(code) {
  if (!isDbConnected) return null;
  try {
    const doc = await LobbyModel.findOne({ code, status: { $ne: 'expired' } }).lean();
    if (!doc) return null;
    doc.players = (doc.players || []).map(p => ({
      jokerAvailable: true, jokerLastUsedAt: 0, ...p,
    }));
    return doc;
  } catch (err) { console.error('DB load error:', err.message); return null; }
}

async function restoreLobbies() {
  if (!isDbConnected) return;
  try {
    const cutoff = new Date(Date.now() - LOBBY_TTL_DAYS * 86400 * 1000);
    const docs = await LobbyModel.find({
      status: { $in: ['waiting','playing'] }, lastActivity: { $gte: cutoff },
    }).lean();
    for (const doc of docs) {
      doc.players = (doc.players||[]).map(p => ({ jokerAvailable: true, jokerLastUsedAt: 0, ...p }));
      lobbies.set(doc.code, doc);
    }
    if (docs.length) console.log(`✦ Restored ${docs.length} lobby/lobbies from DB`);
  } catch (err) { console.error('Lobby restore error:', err.message); }
}

function resolveVote(code) {
  const lobby = lobbies.get(code);
  if (!lobby || !lobby.activeVote) return;
  if (lobby.voteTimeout) { clearTimeout(lobby.voteTimeout); lobby.voteTimeout = null; }
  const vote   = lobby.activeVote;
  lobby.activeVote = null;
  const voters = lobby.players.filter(p =>
    !p.id.startsWith('disconnected:') && p.id !== vote.targetId && !p.isAiPlayer
  );
  const yesVotes = voters.filter(p => vote.votes[p.id] === true).length;
  const passed   = yesVotes > voters.length / 2;
  if (passed) {
    const idx = lobby.players.findIndex(p => p.id === vote.targetId);
    if (idx !== -1) lobby.players.splice(idx, 1);
    if (lobby.currentPlayerIndex >= lobby.players.length) lobby.currentPlayerIndex = 0;
    const kickedSocket = io.sockets.sockets.get(vote.targetId);
    if (kickedSocket) {
      kickedSocket.emit('you-were-kicked', { message: 'The scribes have voted to remove you.' });
      kickedSocket.leave(code);
    }
    io.to(code).emit('vote-resolved', { ...publicState(lobby), notice: `${vote.targetName} was removed by vote.` });
  } else {
    io.to(code).emit('vote-resolved', { ...publicState(lobby), notice: `Vote to remove ${vote.targetName} did not pass.` });
  }
  saveLobby(lobby);
}

// ── SOCKET HANDLERS ───────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('create-lobby', ({ playerName, wordLimit, randomScene, hasAiPlayer, imageEvery, jokerCooldown }) => {
    const name = playerName?.trim().replace(/\s+/g,' ').substring(0, 24);
    if (!name) return socket.emit('err', 'A name is required.');
    let code; do { code = generateCode(); } while (lobbies.has(code));

    const wl = Math.min(Math.max(parseInt(wordLimit)||20, 5), 100);
    const ie = Math.min(Math.max(parseInt(imageEvery)||DEFAULT_IMAGE_EVERY, 2), 20);
    const jc = Math.min(Math.max(parseInt(jokerCooldown)||DEFAULT_JOKER_COOLDOWN, 5), 60);

    const lobby = {
      code, hostId: socket.id,
      players: [{ id: socket.id, name, color: PLAYER_COLORS[0], emblem: PLAYER_EMBLEMS[0],
                  jokerAvailable: true, jokerLastUsedAt: -jc, isAiPlayer: false }],
      story: [], wordLimit: wl, imageEvery: ie, jokerCooldown: jc,
      currentPlayerIndex: 0, promptCount: 0,
      status: 'waiting', currentBackground: null,
      randomScene: !!randomScene, hasAiPlayer: !!hasAiPlayer,
      activeVote: null, voteTimeout: null,
    };

    lobbies.set(code, lobby);
    socket.join(code);
    socket.data = { code, name };
    socket.emit('lobby-created', publicState(lobby));
    saveLobby(lobby);
  });

  socket.on('join-lobby', async ({ code, playerName }) => {
    const c    = code?.trim().toUpperCase();
    const name = playerName?.trim().replace(/\s+/g,' ').substring(0, 24);
    if (!name) return socket.emit('err', 'A name is required.');

    let lobby = lobbies.get(c);
    if (!lobby) { lobby = await loadLobbyFromDb(c); if (lobby) lobbies.set(c, lobby); }
    if (!lobby)                    return socket.emit('err', 'Lobby not found. Double-check the code!');
    if (lobby.status === 'expired') return socket.emit('err', 'This lobby has expired.');

    // Rejoin existing slot first (before capacity check)
    const existingIdx = lobby.players.findIndex(p => !p.isAiPlayer && norm(p.name) === norm(name));
    if (existingIdx !== -1) {
      const slot = lobby.players[existingIdx];
      const oldId = slot.id;
      if (disconnectTimers.has(oldId)) { clearTimeout(disconnectTimers.get(oldId)); disconnectTimers.delete(oldId); }
      slot.id = socket.id;
      if (lobby.hostId === oldId || lobby.hostId === `disconnected:${slot.name}`) lobby.hostId = socket.id;
      advanceToActive(lobby);
      socket.join(c); socket.data = { code: c, name: slot.name };
      socket.emit('lobby-joined', publicState(lobby));
      socket.to(c).emit('lobby-updated', publicState(lobby));
      saveLobby(lobby); return;
    }

    const humanCount = lobby.players.filter(p => !p.isAiPlayer).length;
    if (humanCount >= MAX_PLAYERS)  return socket.emit('err', 'The tavern is full (4/4).');
    if (lobby.status !== 'waiting') return socket.emit('err', 'This story has already begun.');

    const idx = humanCount; // color/emblem index based on human count
    lobby.players.push({
      id: socket.id, name,
      color: PLAYER_COLORS[idx % PLAYER_COLORS.length],
      emblem: PLAYER_EMBLEMS[idx % PLAYER_EMBLEMS.length],
      jokerAvailable: true,
      jokerLastUsedAt: -(lobby.jokerCooldown || DEFAULT_JOKER_COOLDOWN),
      isAiPlayer: false,
    });
    socket.join(c); socket.data = { code: c, name };
    socket.emit('lobby-joined', publicState(lobby));
    socket.to(c).emit('lobby-updated', publicState(lobby));
    saveLobby(lobby);
  });

  socket.on('rejoin-session', async ({ code, name }) => {
    const c = code?.trim().toUpperCase();
    let lobby = lobbies.get(c);
    if (!lobby) { lobby = await loadLobbyFromDb(c); if (lobby) lobbies.set(c, lobby); }
    if (!lobby) return;

    const idx = lobby.players.findIndex(p => !p.isAiPlayer && norm(p.name) === norm(name));
    if (idx === -1) return;

    const slot  = lobby.players[idx];
    const oldId = slot.id;
    if (disconnectTimers.has(oldId)) { clearTimeout(disconnectTimers.get(oldId)); disconnectTimers.delete(oldId); }
    slot.id = socket.id;
    if (lobby.hostId === oldId || lobby.hostId === `disconnected:${slot.name}`) lobby.hostId = socket.id;
    advanceToActive(lobby);
    socket.join(c); socket.data = { code: c, name: slot.name };
    socket.emit('lobby-joined', publicState(lobby));
    socket.to(c).emit('lobby-updated', publicState(lobby));
    saveLobby(lobby);
  });

  socket.on('start-game', async () => {
    const { code } = socket.data ?? {};
    const lobby    = lobbies.get(code);
    if (!lobby) return;
    if (lobby.status === 'playing') return; // guard against double-click / double-emit
    if (lobby.hostId !== socket.id) return socket.emit('err', 'Only the host may begin the tale.');

    const humanPlayers = lobby.players.filter(p => !p.isAiPlayer);
    if (humanPlayers.length < 2) return socket.emit('err', 'You need at least 2 scribes to start.');

    lobby.status = 'playing';

    // Insert AI player at a random position among human players
    if (lobby.hasAiPlayer && !lobby.players.some(p => p.isAiPlayer)) {
      const insertAt = Math.floor(Math.random() * (humanPlayers.length + 1));
      lobby.players.splice(insertAt, 0, { ...AI_PLAYER, jokerLastUsedAt: -(lobby.jokerCooldown||DEFAULT_JOKER_COOLDOWN) });
    }

    if (lobby.randomScene) {
      io.to(code).emit('generating-scene', publicState(lobby));
      const sceneText = await generateOpeningScene();
      lobby.story.push({
        playerId: 'ai', playerName: 'The Muse', playerColor: '#c084fc',
        playerEmblem: '✦', text: sceneText, timestamp: Date.now(),
        usedJoker: false, isAiScene: true,
      });
      lobby.promptCount++;
      triggerBackground(code, lobby.story, lobby.imageEvery);
    }

    advanceToActive(lobby);
    io.to(code).emit('game-started', publicState(lobby));
    saveLobby(lobby);

    // If first player is AI, trigger its turn
    if (lobby.players[lobby.currentPlayerIndex]?.id === 'ai-player') {
      generateAiTurn(code).catch(e => console.error('AI first turn error:', e));
    }
  });

  socket.on('submit-turn', ({ text, useJoker }) => {
    const { code } = socket.data ?? {};
    const lobby    = lobbies.get(code);
    if (!lobby || lobby.status !== 'playing') return;

    const active = lobby.players[lobby.currentPlayerIndex];
    if (active?.id !== socket.id) return socket.emit('err', 'It is not your turn, scribe.');

    const trimmed = text?.trim() ?? '';
    const words   = trimmed.split(/\s+/).filter(Boolean);
    if (words.length === 0) return socket.emit('err', 'Write something before submitting!');

    const ie         = lobby.imageEvery   || DEFAULT_IMAGE_EVERY;
    const jc         = lobby.jokerCooldown || DEFAULT_JOKER_COOLDOWN;
    const isFirstTurn = lobby.promptCount === 0 && !lobby.randomScene;
    const baseLimit  = isFirstTurn ? FIRST_TURN_LIMIT : lobby.wordLimit;
    const jokerWanted = useJoker && active.jokerAvailable && !isFirstTurn;
    const effectiveLimit = jokerWanted ? baseLimit * 2 : baseLimit;

    if (words.length > effectiveLimit) return socket.emit('err', `Too many words! Limit is ${effectiveLimit}.`);

    if (jokerWanted) { active.jokerAvailable = false; active.jokerLastUsedAt = lobby.promptCount; }

    lobby.story.push({
      playerId: socket.id, playerName: active.name, playerColor: active.color,
      playerEmblem: active.emblem, text: trimmed, timestamp: Date.now(), usedJoker: jokerWanted,
    });
    lobby.promptCount++;
    lobby.currentPlayerIndex = (lobby.currentPlayerIndex + 1) % lobby.players.length;

    for (const p of lobby.players) {
      if (!p.jokerAvailable && !p.isAiPlayer && (lobby.promptCount - p.jokerLastUsedAt) >= jc) {
        p.jokerAvailable = true;
      }
    }
    if (lobby.promptCount % ie === 0) triggerBackground(code, lobby.story, ie);
    advanceToActive(lobby);

    io.to(code).emit('story-updated', publicState(lobby));
    saveLobby(lobby);

    // Trigger AI turn if next up
    if (lobby.players[lobby.currentPlayerIndex]?.id === 'ai-player') {
      io.to(code).emit('ai-thinking', publicState(lobby));
      generateAiTurn(code).catch(e => console.error('AI turn error:', e));
    }
  });

  socket.on('skip-turn', () => {
    const { code } = socket.data ?? {};
    const lobby    = lobbies.get(code);
    if (!lobby || lobby.status !== 'playing') return;
    const active = lobby.players[lobby.currentPlayerIndex];
    if (active?.id !== socket.id) return socket.emit('err', 'It is not your turn.');
    const name = active.name;
    lobby.currentPlayerIndex = (lobby.currentPlayerIndex + 1) % lobby.players.length;
    advanceToActive(lobby);
    io.to(code).emit('turn-skipped', { ...publicState(lobby), notice: `${name} passed their turn.` });
    saveLobby(lobby);

    if (lobby.players[lobby.currentPlayerIndex]?.id === 'ai-player') {
      io.to(code).emit('ai-thinking', publicState(lobby));
      generateAiTurn(code).catch(e => console.error('AI turn (after skip) error:', e));
    }
  });

  socket.on('initiate-vote-kick', ({ targetId }) => {
    const { code } = socket.data ?? {};
    const lobby    = lobbies.get(code);
    if (!lobby || lobby.status !== 'playing') return;
    if (lobby.activeVote) return socket.emit('err', 'A vote is already in progress.');
    const target = lobby.players.find(p => p.id === targetId);
    if (!target || target.isAiPlayer) return socket.emit('err', 'Cannot vote kick that player.');
    if (targetId === socket.id) return socket.emit('err', "You can't vote kick yourself.");
    const me = lobby.players.find(p => p.id === socket.id);
    lobby.activeVote = {
      targetId, targetName: target.name, startedByName: me?.name,
      votes: { [socket.id]: true }, startedAt: Date.now(),
    };
    lobby.voteTimeout = setTimeout(() => resolveVote(code), VOTE_TIMEOUT_MS);
    io.to(code).emit('vote-started', { ...publicState(lobby), notice: `${me?.name} called a vote to remove ${target.name}.` });
  });

  socket.on('cast-vote', ({ approve }) => {
    const { code } = socket.data ?? {};
    const lobby    = lobbies.get(code);
    if (!lobby || !lobby.activeVote) return;
    if (socket.id === lobby.activeVote.targetId) return;
    lobby.activeVote.votes[socket.id] = approve;
    const voters = lobby.players.filter(p =>
      !p.id.startsWith('disconnected:') && p.id !== lobby.activeVote.targetId && !p.isAiPlayer
    );
    if (voters.every(p => lobby.activeVote.votes[p.id] !== undefined)) resolveVote(code);
    else io.to(code).emit('vote-updated', publicState(lobby));
  });

  socket.on('disconnect', () => {
    const { code } = socket.data ?? {};
    if (!code) return;
    const lobby = lobbies.get(code);
    if (!lobby) return;
    const idx = lobby.players.findIndex(p => p.id === socket.id && !p.isAiPlayer);
    if (idx === -1) return;
    const leavingName = lobby.players[idx].name;

    const timer = setTimeout(() => {
      disconnectTimers.delete(socket.id);
      const lobby = lobbies.get(code);
      if (!lobby) return;
      const p = lobby.players.find(p => p.id === socket.id);
      if (!p) return;
      p.id = `disconnected:${leavingName}`;
      const active = lobby.players.filter(p => !p.id.startsWith('disconnected:'));
      if (active.length === 0 || (active.length === 1 && active[0].isAiPlayer)) {
        setTimeout(() => {
          const l = lobbies.get(code);
          if (l && l.players.filter(p => !p.isAiPlayer).every(p => p.id.startsWith('disconnected:'))) lobbies.delete(code);
        }, 600000);
        return;
      }
      if (lobby.hostId === socket.id) {
        const newHost = active.find(p => !p.isAiPlayer);
        if (newHost) lobby.hostId = newHost.id;
      }
      advanceToActive(lobby);
      io.to(code).emit('player-left', { ...publicState(lobby), notice: `${leavingName} vanished into the mist…` });
      saveLobby(lobby);
    }, 20000);

    disconnectTimers.set(socket.id, timer);
  });
});

// ── STATIC FILES ──────────────────────────────────────────────────────
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
