const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const allQuestions = require("./questions.json");

const PORT = process.env.PORT || 3000;
const NUMBER_OF_ROUNDS = 8;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 12;
const MAX_NAME_LENGTH = 16;
const MAX_EXTRA_NAMES = 10;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// QR code d'une salle : il encode l'adresse du site suivie de ?code=XXXX
app.get("/qr/:code", async (req, res) => {
  const code = req.params.code.toUpperCase();
  if (!rooms.has(code)) {
    return res.status(404).end();
  }

  const joinUrl = `${req.protocol}://${req.get("host")}/?code=${code}`;
  const svg = await QRCode.toString(joinUrl, { type: "svg", margin: 2 });
  res.type("image/svg+xml").send(svg);
});

// Toutes les salles en mémoire, indexées par leur code (ex: "KXQM")
const rooms = new Map();

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function generateRoomCode() {
  // Pas de I, O, 0, 1 pour éviter les confusions à la saisie
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code = "";
  do {
    code = "";
    for (let i = 0; i < 4; i++) {
      code += letters[Math.floor(Math.random() * letters.length)];
    }
  } while (rooms.has(code));
  return code;
}

function generatePlayerId() {
  return Math.random().toString(36).slice(2, 10);
}

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function cleanName(rawName) {
  return String(rawName || "").trim().slice(0, MAX_NAME_LENGTH);
}

function getPlayersAsList(room) {
  return Array.from(room.players.values());
}

function getConnectedPlayers(room) {
  return getPlayersAsList(room).filter((player) => player.connected);
}

// Un nom est déjà pris s'il est utilisé par un joueur ou par un nom ajouté à la liste
function isNameTaken(room, name) {
  const lowerName = name.toLowerCase();
  const usedByPlayer = getPlayersAsList(room).some(
    (player) => player.name.toLowerCase() === lowerName
  );
  const usedByExtra = room.extraNames.some((extra) => extra.name.toLowerCase() === lowerName);
  return usedByPlayer || usedByExtra;
}

function isCandidate(room, id) {
  return room.candidates.some((candidate) => candidate.id === id);
}

// ---------------------------------------------------------------------------
// Création et état d'une salle
// ---------------------------------------------------------------------------

function createRoom() {
  const room = {
    code: generateRoomCode(),
    hostId: null,
    players: new Map(), // playerId -> { id, name, socketId, connected, score }
    phase: "lobby", // lobby | voting | results | final
    extraNames: [], // noms ajoutés par l'hôte, proposés en réponse sans être des joueurs : { id, name }
    candidates: [], // la liste des réponses possibles, fixée au lancement : { id, name }
    questions: [],
    roundIndex: 0,
    votes: new Map(), // voterId -> candidateId
    lastResults: null,
  };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, name, socketId) {
  const player = {
    id: generatePlayerId(),
    name: name,
    socketId: socketId,
    connected: true,
    score: 0,
  };
  room.players.set(player.id, player);
  if (room.hostId === null) {
    room.hostId = player.id;
  }
  return player;
}

function buildResults(room) {
  const votesByCandidate = new Map();
  for (const candidate of room.candidates) {
    votesByCandidate.set(candidate.id, 0);
  }

  const namesById = new Map();
  for (const candidate of room.candidates) {
    namesById.set(candidate.id, candidate.name);
  }

  const voteDetails = [];
  for (const [voterId, candidateId] of room.votes) {
    votesByCandidate.set(candidateId, votesByCandidate.get(candidateId) + 1);
    voteDetails.push({
      voterName: room.players.get(voterId).name,
      candidateName: namesById.get(candidateId),
    });
  }

  const tally = room.candidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    votes: votesByCandidate.get(candidate.id),
  }));
  tally.sort((a, b) => b.votes - a.votes);

  return { tally: tally, voteDetails: voteDetails };
}

// Vue envoyée à un joueur précis. On ne révèle jamais les votes pendant le vote.
function buildStateForPlayer(room, playerId) {
  const players = getPlayersAsList(room).map((player) => ({
    id: player.id,
    name: player.name,
    connected: player.connected,
    hasVoted: room.votes.has(player.id),
  }));

  const ranking = getPlayersAsList(room)
    .map((player) => ({ id: player.id, name: player.name, score: player.score }))
    .sort((a, b) => b.score - a.score);

  return {
    code: room.code,
    phase: room.phase,
    youId: playerId,
    hostId: room.hostId,
    players: players,
    extraNames: room.extraNames,
    maxExtraNames: MAX_EXTRA_NAMES,
    candidates: room.candidates,
    question: room.phase === "lobby" ? null : room.questions[room.roundIndex],
    roundNumber: room.roundIndex + 1,
    totalRounds: room.questions.length,
    myVote: room.votes.get(playerId) || null,
    results: room.phase === "results" ? room.lastResults : null,
    ranking: ranking,
    minPlayers: MIN_PLAYERS,
  };
}

function broadcastState(room) {
  for (const player of room.players.values()) {
    if (player.connected) {
      io.to(player.socketId).emit("state", buildStateForPlayer(room, player.id));
    }
  }
}

// ---------------------------------------------------------------------------
// Déroulement de la partie
// ---------------------------------------------------------------------------

function startGame(room) {
  const connectedPlayers = getConnectedPlayers(room);
  const playerCandidates = connectedPlayers.map((player) => ({ id: player.id, name: player.name }));
  room.candidates = [...playerCandidates, ...room.extraNames];
  room.questions = shuffle(allQuestions).slice(0, NUMBER_OF_ROUNDS);
  room.roundIndex = 0;
  for (const player of room.players.values()) {
    player.score = 0;
  }
  startRound(room);
}

function startRound(room) {
  room.votes = new Map();
  room.lastResults = null;
  room.phase = "voting";
}

function finishVoting(room) {
  room.lastResults = buildResults(room);
  for (const entry of room.lastResults.tally) {
    const player = room.players.get(entry.id);
    // Les noms ajoutés à la liste ne sont pas des joueurs : pas de score
    if (player) {
      player.score += entry.votes;
    }
  }
  room.phase = "results";
}

function goToNextRound(room) {
  const isLastRound = room.roundIndex >= room.questions.length - 1;
  if (isLastRound) {
    room.phase = "final";
    return;
  }
  room.roundIndex += 1;
  startRound(room);
}

// Les votes ne comptent que pour les joueurs présents au lancement et connectés
function haveAllConnectedCandidatesVoted(room) {
  const voters = getConnectedPlayers(room).filter((player) => isCandidate(room, player.id));
  if (voters.length === 0) {
    return false;
  }
  return voters.every((player) => room.votes.has(player.id));
}

// ---------------------------------------------------------------------------
// Événements Socket.IO
// ---------------------------------------------------------------------------

io.on("connection", (socket) => {
  // Contexte du joueur attaché à cette connexion
  let currentRoom = null;
  let currentPlayerId = null;

  function attach(room, player) {
    currentRoom = room;
    currentPlayerId = player.id;
    player.socketId = socket.id;
    player.connected = true;
    socket.emit("joined", { code: room.code, playerId: player.id });
    broadcastState(room);
  }

  socket.on("room:create", (data, reply) => {
    const name = cleanName(data && data.name);
    if (!name) {
      return reply({ error: "Choisis un pseudo." });
    }
    const room = createRoom();
    const player = addPlayer(room, name, socket.id);
    attach(room, player);
    reply({ ok: true });
  });

  socket.on("room:join", (data, reply) => {
    const name = cleanName(data && data.name);
    const code = String((data && data.code) || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!name) {
      return reply({ error: "Choisis un pseudo." });
    }
    if (!room) {
      return reply({ error: "Salle introuvable." });
    }
    if (room.phase !== "lobby") {
      return reply({ error: "La partie a déjà commencé." });
    }
    if (room.players.size >= MAX_PLAYERS) {
      return reply({ error: "La salle est pleine." });
    }
    if (isNameTaken(room, name)) {
      return reply({ error: "Ce pseudo est déjà pris." });
    }

    const player = addPlayer(room, name, socket.id);
    attach(room, player);
    reply({ ok: true });
  });

  // Reconnexion après un rafraîchissement ou une coupure réseau
  socket.on("room:rejoin", (data, reply) => {
    const room = rooms.get(String((data && data.code) || ""));
    const player = room && room.players.get(data.playerId);
    if (!player) {
      return reply({ error: "Session expirée." });
    }
    attach(room, player);
    reply({ ok: true });
  });

  socket.on("game:start", () => {
    if (!currentRoom || currentPlayerId !== currentRoom.hostId) return;
    if (currentRoom.phase !== "lobby") return;
    if (getConnectedPlayers(currentRoom).length < MIN_PLAYERS) return;
    startGame(currentRoom);
    broadcastState(currentRoom);
  });

  socket.on("extra:add", (data, reply) => {
    if (!currentRoom || currentPlayerId !== currentRoom.hostId) return;
    if (currentRoom.phase !== "lobby") return;

    const name = cleanName(data && data.name);
    if (!name) {
      return reply({ error: "Écris un nom." });
    }
    if (currentRoom.extraNames.length >= MAX_EXTRA_NAMES) {
      return reply({ error: `Maximum ${MAX_EXTRA_NAMES} noms.` });
    }
    if (isNameTaken(currentRoom, name)) {
      return reply({ error: "Ce nom existe déjà." });
    }

    currentRoom.extraNames.push({ id: "extra-" + generatePlayerId(), name: name });
    reply({ ok: true });
    broadcastState(currentRoom);
  });

  socket.on("extra:remove", (data) => {
    if (!currentRoom || currentPlayerId !== currentRoom.hostId) return;
    if (currentRoom.phase !== "lobby") return;

    const extraId = data && data.id;
    currentRoom.extraNames = currentRoom.extraNames.filter((extra) => extra.id !== extraId);
    broadcastState(currentRoom);
  });

  socket.on("vote:submit", (data) => {
    if (!currentRoom || currentRoom.phase !== "voting") return;
    if (!isCandidate(currentRoom, currentPlayerId)) return;

    const candidateId = data && data.candidateId;
    if (!isCandidate(currentRoom, candidateId)) return;

    currentRoom.votes.set(currentPlayerId, candidateId);

    if (haveAllConnectedCandidatesVoted(currentRoom)) {
      finishVoting(currentRoom);
    }
    broadcastState(currentRoom);
  });

  // L'hôte peut clore le vote même si quelqu'un traîne
  socket.on("vote:force-end", () => {
    if (!currentRoom || currentPlayerId !== currentRoom.hostId) return;
    if (currentRoom.phase !== "voting") return;
    finishVoting(currentRoom);
    broadcastState(currentRoom);
  });

  socket.on("round:next", () => {
    if (!currentRoom || currentPlayerId !== currentRoom.hostId) return;
    if (currentRoom.phase !== "results") return;
    goToNextRound(currentRoom);
    broadcastState(currentRoom);
  });

  socket.on("game:restart", () => {
    if (!currentRoom || currentPlayerId !== currentRoom.hostId) return;
    if (currentRoom.phase !== "final") return;
    currentRoom.phase = "lobby";
    currentRoom.votes = new Map();
    broadcastState(currentRoom);
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const player = currentRoom.players.get(currentPlayerId);
    if (!player || player.socketId !== socket.id) return;

    player.connected = false;

    // En salon, un joueur qui part est retiré pour de bon
    if (currentRoom.phase === "lobby") {
      currentRoom.players.delete(player.id);
    }

    const stillConnected = getConnectedPlayers(currentRoom);
    if (stillConnected.length === 0) {
      rooms.delete(currentRoom.code);
      return;
    }

    // Si l'hôte est parti, le premier joueur connecté prend le relais
    if (currentRoom.hostId === player.id) {
      currentRoom.hostId = stillConnected[0].id;
    }

    // Le joueur absent bloquait peut-être le vote
    if (currentRoom.phase === "voting" && haveAllConnectedCandidatesVoted(currentRoom)) {
      finishVoting(currentRoom);
    }
    broadcastState(currentRoom);
  });
});

server.listen(PORT, () => {
  console.log(`Serveur lancé sur http://localhost:${PORT}`);
});
