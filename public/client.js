const socket = io();
const app = document.getElementById("app");

const SESSION_KEY = "qui-et-pourquoi-session";

let state = null; // dernier état reçu du serveur
let homeError = "";

// ---------------------------------------------------------------------------
// Session (pour revenir dans la partie après un rafraîchissement)
// ---------------------------------------------------------------------------

function saveSession(code, playerId) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ code: code, playerId: playerId }));
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch (error) {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

// ---------------------------------------------------------------------------
// Utilitaires d'affichage
// ---------------------------------------------------------------------------

// Les pseudos viennent des joueurs : on les échappe avant de les mettre dans le HTML
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function pluralVotes(count) {
  return count + (count > 1 ? " votes" : " vote");
}

function isHost() {
  return state.youId === state.hostId;
}

// ---------------------------------------------------------------------------
// Écrans
// ---------------------------------------------------------------------------

function renderHome() {
  app.innerHTML = `
    <h1>Qui est le plus... ?</h1>
    <p class="discret">Un jeu à jouer entre amis, chacun sur son téléphone.</p>
    <div class="carte">
      <input id="name" placeholder="Ton pseudo" maxlength="16" autocomplete="off">
      <button id="create">Créer une partie</button>
    </div>
    <div class="carte">
      <input id="code" class="code" placeholder="CODE" maxlength="4" autocomplete="off">
      <button id="join" class="secondaire">Rejoindre</button>
    </div>
    <p class="erreur">${escapeHtml(homeError)}</p>
  `;

  const nameInput = document.getElementById("name");
  const codeInput = document.getElementById("code");

  // Arrivée par QR code : l'adresse contient ?code=XXXX
  const codeFromUrl = new URLSearchParams(window.location.search).get("code");
  if (codeFromUrl) {
    codeInput.value = codeFromUrl.toUpperCase().slice(0, 4);
  }

  document.getElementById("create").onclick = () => {
    socket.emit("room:create", { name: nameInput.value }, handleJoinReply);
  };
  document.getElementById("join").onclick = () => {
    socket.emit("room:join", { name: nameInput.value, code: codeInput.value }, handleJoinReply);
  };
}

function renderLobby() {
  const playerLines = state.players
    .map(
      (player) => `
      <li class="ligne ${player.connected ? "" : "hors-ligne"}">
        <span>${escapeHtml(player.name)}</span>
        <span class="badge">${player.id === state.hostId ? "hôte" : ""}</span>
      </li>`
    )
    .join("");

  const connectedCount = state.players.filter((player) => player.connected).length;
  const enabledQuestionCount = state.categories
    .filter((category) => category.enabled)
    .reduce((total, category) => total + category.questionCount, 0);
  const enoughPlayers = connectedCount >= state.minPlayers;
  const hasQuestions = enabledQuestionCount > 0;
  const canStart = isHost() && enoughPlayers && hasQuestions;

  let footer = "";
  if (isHost()) {
    footer = `<button id="start" ${canStart ? "" : "disabled"}>Lancer la partie</button>`;
    if (!enoughPlayers) {
      footer += `<p class="discret">Il faut au moins ${state.minPlayers} joueurs.</p>`;
    } else if (!hasQuestions) {
      footer += `<p class="discret">Active au moins une catégorie de questions.</p>`;
    }
  } else {
    footer = `<p class="discret">En attente de l'hôte...</p>`;
  }

  // Les catégories de questions : l'hôte les active ou non en touchant la ligne
  const categoryLines = state.categories
    .map((category) => {
      const label = `${escapeHtml(category.name)} <span class="badge">${category.questionCount}</span>`;
      const stateText = category.enabled ? "activée" : "désactivée";
      if (!isHost()) {
        return `<li class="ligne ${category.enabled ? "" : "hors-ligne"}"><span>${label}</span><span class="badge">${stateText}</span></li>`;
      }
      return `
      <li>
        <button class="categorie ${category.enabled ? "choisi" : "secondaire"}" data-id="${category.id}">
          <span>${label}</span>
          <span>${category.enabled ? "oui" : "non"}</span>
        </button>
      </li>`;
    })
    .join("");

  // Les noms hors joueurs : l'hôte peut en ajouter ou en retirer, les autres les voient
  const extraLines = state.extraNames
    .map(
      (extra) => `
      <li class="ligne">
        <span>${escapeHtml(extra.name)}</span>
        ${isHost() ? `<button class="retirer" data-id="${extra.id}" aria-label="Retirer">&times;</button>` : ""}
      </li>`
    )
    .join("");

  const extraForm = isHost()
    ? `
      <div class="ajout">
        <input id="extra" placeholder="Ajouter un nom" maxlength="16" autocomplete="off">
        <button id="add-extra" class="secondaire">Ajouter</button>
      </div>
      <p id="extra-error" class="erreur"></p>`
    : "";

  // Le re-rendu efface le champ : on garde ce que l'hôte était en train d'écrire
  const previousInput = document.getElementById("extra");
  const previousText = previousInput ? previousInput.value : "";
  const hadFocus = previousInput !== null && document.activeElement === previousInput;

  app.innerHTML = `
    <p class="discret">Code de la salle</p>
    <div class="code-salle">${state.code}</div>
    <img class="qr" src="/qr/${state.code}" alt="QR code pour rejoindre la salle" width="200" height="200">
    <div class="carte">
      <h3>Joueurs</h3>
      <ul class="liste">${playerLines}</ul>
    </div>
    <div class="carte">
      <h3>Catégories de questions</h3>
      <ul class="liste">${categoryLines}</ul>
      <p class="discret">${enabledQuestionCount} questions disponibles, ${state.maxRounds} maximum par partie.</p>
    </div>
    <div class="carte">
      <h3>Autres noms proposés en réponse</h3>
      <p class="discret">Ils ne votent pas, mais on peut voter pour eux.</p>
      ${extraLines ? `<ul class="liste">${extraLines}</ul>` : ""}
      ${extraForm}
    </div>
    ${footer}
  `;

  const startButton = document.getElementById("start");
  if (startButton) {
    startButton.onclick = () => socket.emit("game:start");
  }

  const extraInput = document.getElementById("extra");
  if (extraInput) {
    extraInput.value = previousText;
    if (hadFocus) {
      extraInput.focus();
    }

    const addExtraName = () => {
      socket.emit("extra:add", { name: extraInput.value }, (reply) => {
        if (reply.error) {
          document.getElementById("extra-error").textContent = reply.error;
        }
      });
      extraInput.value = "";
    };
    document.getElementById("add-extra").onclick = addExtraName;
    extraInput.onkeydown = (event) => {
      if (event.key === "Enter") addExtraName();
    };
  }

  for (const button of app.querySelectorAll("button.categorie")) {
    button.onclick = () => socket.emit("category:toggle", { id: button.dataset.id });
  }

  for (const button of app.querySelectorAll("button.retirer")) {
    button.onclick = () => socket.emit("extra:remove", { id: button.dataset.id });
  }
}

function renderVoting() {
  const voters = state.players.filter((player) => state.candidates.some((c) => c.id === player.id));
  const votedCount = voters.filter((player) => player.hasVoted).length;

  const choices = state.candidates
    .map(
      (candidate) => `
      <button class="choix ${state.myVote === candidate.id ? "choisi" : ""}" data-id="${candidate.id}">
        ${escapeHtml(candidate.name)}
      </button>`
    )
    .join("");

  const forceButton = isHost()
    ? `<button id="force" class="secondaire">Terminer le vote</button>`
    : "";

  app.innerHTML = `
    <p class="progression">Question ${state.roundNumber} / ${state.totalRounds}</p>
    <h2>${escapeHtml(state.question)}</h2>
    <div class="liste">${choices}</div>
    <p class="progression">${votedCount} / ${voters.length} ont voté</p>
    ${forceButton}
  `;

  for (const button of app.querySelectorAll("button.choix")) {
    button.onclick = () => socket.emit("vote:submit", { candidateId: button.dataset.id });
  }
  const force = document.getElementById("force");
  if (force) {
    force.onclick = () => socket.emit("vote:force-end");
  }
}

function renderResults() {
  const results = state.results;
  const bestScore = results.tally[0].votes;

  const tallyLines = results.tally
    .map((entry) => {
      const isWinner = entry.votes === bestScore && bestScore > 0;
      return `
      <li class="ligne ${isWinner ? "gagnant" : ""}">
        <span>${escapeHtml(entry.name)}</span>
        <span class="badge">${pluralVotes(entry.votes)}</span>
      </li>`;
    })
    .join("");

  const detailLines = results.voteDetails
    .map(
      (vote) =>
        `<p>${escapeHtml(vote.voterName)} a voté pour <strong>${escapeHtml(vote.candidateName)}</strong></p>`
    )
    .join("");

  const nextLabel = state.roundNumber >= state.totalRounds ? "Voir le classement" : "Question suivante";
  const nextButton = isHost()
    ? `<button id="next">${nextLabel}</button>`
    : `<p class="discret">En attente de l'hôte...</p>`;

  app.innerHTML = `
    <h2>${escapeHtml(state.question)}</h2>
    <ul class="liste">${tallyLines}</ul>
    <div class="carte detail-votes">${detailLines}</div>
    ${nextButton}
  `;

  const next = document.getElementById("next");
  if (next) {
    next.onclick = () => socket.emit("round:next");
  }
}

function renderFinal() {
  const bestScore = state.ranking[0].score;

  const lines = state.ranking
    .map(
      (entry) => `
      <li class="ligne ${entry.score === bestScore ? "gagnant" : ""}">
        <span>${escapeHtml(entry.name)}</span>
        <span class="badge">${pluralVotes(entry.score)}</span>
      </li>`
    )
    .join("");

  const restartButton = isHost()
    ? `<button id="restart">Rejouer</button>`
    : `<p class="discret">En attente de l'hôte...</p>`;

  app.innerHTML = `
    <h1>Classement final</h1>
    <p class="discret">Le plus désigné de la soirée</p>
    <ul class="liste">${lines}</ul>
    ${restartButton}
  `;

  const restart = document.getElementById("restart");
  if (restart) {
    restart.onclick = () => socket.emit("game:restart");
  }
}

function render() {
  if (!state) {
    renderHome();
    return;
  }
  if (state.phase === "lobby") renderLobby();
  else if (state.phase === "voting") renderVoting();
  else if (state.phase === "results") renderResults();
  else if (state.phase === "final") renderFinal();
}

// ---------------------------------------------------------------------------
// Réseau
// ---------------------------------------------------------------------------

function handleJoinReply(reply) {
  if (reply.error) {
    homeError = reply.error;
    renderHome();
  }
}

socket.on("joined", (data) => {
  saveSession(data.code, data.playerId);
});

socket.on("state", (newState) => {
  state = newState;
  render();
});

// Appelé à la première connexion et à chaque reconnexion automatique
socket.on("connect", () => {
  const session = loadSession();
  if (!session) {
    render();
    return;
  }
  socket.emit("room:rejoin", session, (reply) => {
    if (reply.error) {
      clearSession();
      state = null;
      render();
    }
  });
});
