
const express = require("express");
const http = require("http");
const path = require("path");
const { randomInt, randomUUID } = require("crypto");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const MAX_PLAYERS = 20;
const MAX_ROUNDS = 10;
const WRITE_TIME = 60;
const VOTE_TIME = 90;
const RESULT_TIME = 5;

app.use(express.static(path.join(__dirname, "public")));

const images = Array.from({ length: 10 }, (_, i) =>
    `/images/bild${String(i + 1).padStart(2, "0")}.jpg`
);

const rooms = new Map();
const playerRooms = new Map();

function makeCode() {
    let code;

    do {
        code = String(randomInt(100000, 1000000));
    } while (rooms.has(code));

    return code;
}

function publicPlayers(room) {
    return [...room.players.values()].map(p => ({
        name: p.name,
        points: p.points
    }));
}

function ranking(room) {
    return [...room.players.values()]
        .map(p => ({ name: p.name, points: p.points }))
        .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
}

function sendRanking(room) {
    io.to(room.code).emit("game:ranking", ranking(room));
}

function sendLobby(room) {
    io.to(room.code).emit("room:players", {
        players: publicPlayers(room)
    });
}

function sendPhase(room) {
    io.to(room.code).emit("game:phase", {
        phase: room.phase,
        round: room.round,
        totalRounds: MAX_ROUNDS,
        deadline: room.deadline,
        duration: room.duration
    });
}

function clearTimer(room) {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
}

function setPhaseTimer(room, seconds, callback) {
    clearTimer(room);
    room.duration = seconds;
    room.deadline = Date.now() + seconds * 1000;
    sendPhase(room);

    room.timer = setTimeout(() => {
        room.timer = null;
        callback();
    }, seconds * 1000);
}

function roomOf(socket) {
    const code = playerRooms.get(socket.id);
    return code ? rooms.get(code) : null;
}

function sendError(socket, message) {
    socket.emit("app:error", message);
}

function joinRoom(socket, room, name, isHost, qrCode = null) {
    room.players.set(socket.id, {
        id: socket.id,
        name,
        points: 0,
        description: null,
        submitted: false,
        vote: null
    });

    playerRooms.set(socket.id, room.code);
    socket.join(room.code);

    socket.emit("room:ready", {
        code: room.code,
        isHost,
        qrCode
    });

    sendLobby(room);
}

function currentDescriptions(room) {
    return [...room.players.values()]
        .filter(p => p.submitted && p.description)
        .map(p => ({
            id: p.id,
            text: p.description
        }));
}

function startRound(room) {
    clearTimer(room);

    if (room.round > MAX_ROUNDS || room.players.size === 0) {
        endGame(room);
        return;
    }

    room.phase = "writing";
    room.descriptions = new Map();

    for (const player of room.players.values()) {
        player.description = null;
        player.submitted = false;
        player.vote = null;
    }

    io.to(room.code).emit("game:round", {
        round: room.round,
        totalRounds: MAX_ROUNDS,
        image: images[room.round - 1]
    });

    setPhaseTimer(room, WRITE_TIME, () => startVoting(room));
    sendRanking(room);
}

function submitDescription(socket, text) {
    const room = roomOf(socket);

    if (!room || room.phase !== "writing") return;

    const player = room.players.get(socket.id);
    if (!player || player.submitted) return;

    if (typeof text !== "string") {
        sendError(socket, "Ungültige Beschreibung.");
        return;
    }

    text = text.trim();

    if (text.length < 1 || text.length > 200) {
        sendError(socket, "Die Beschreibung muss 1 bis 200 Zeichen lang sein.");
        return;
    }

    player.description = text;
    player.submitted = true;
    room.descriptions.set(socket.id, text);

    socket.emit("game:descriptionAccepted");

    const activePlayers = [...room.players.values()];

    if (activePlayers.length > 0 &&
        activePlayers.every(p => p.submitted)) {
        startVoting(room);
    }
}

function startVoting(room) {
    if (room.phase !== "writing") return;

    clearTimer(room);

    const descriptions = currentDescriptions(room);

    if (descriptions.length === 0) {
        finishRound(room);
        return;
    }

    room.phase = "voting";

    // Die Autorenzuordnung bleibt serverseitig.
    // Der Browser erhält nur anonyme IDs und Texte.
    const options = descriptions.map(d => ({
        id: randomUUID(),
        text: d.text
    }));

    room.voteOptions = options;

    // Interne Zuordnung zwischen Option und Autor.
    room.optionAuthors = new Map(
        options.map((option, i) => [
            option.id,
            descriptions[i].id
        ])
    );

    io.to(room.code).emit("game:voting", {
        options
    });

    setPhaseTimer(room, VOTE_TIME, () => finishRound(room));
}

function submitVote(socket, optionId) {
    const room = roomOf(socket);

    if (!room || room.phase !== "voting") return;

    const voter = room.players.get(socket.id);
    if (!voter || voter.vote !== null) return;

    if (typeof optionId !== "string") return;

    const authorId = room.optionAuthors.get(optionId);

    if (!authorId) {
        sendError(socket, "Diese Abstimmung ist ungültig.");
        return;
    }

    if (authorId === socket.id) {
        sendError(socket, "Du darfst nicht für deine eigene Beschreibung stimmen.");
        return;
    }

    voter.vote = optionId;

    socket.emit("game:voteAccepted");

    const activePlayers = [...room.players.values()];

    if (activePlayers.every(p => p.vote !== null)) {
        finishRound(room);
    }
}

function finishRound(room) {
    if (!["writing", "voting"].includes(room.phase)) return;

    clearTimer(room);

    const counts = new Map();

    for (const option of room.voteOptions || []) {
        counts.set(option.id, 0);
    }

    for (const player of room.players.values()) {
        if (player.vote && counts.has(player.vote)) {
            counts.set(player.vote, counts.get(player.vote) + 1);

            const authorId = room.optionAuthors.get(player.vote);
            const author = room.players.get(authorId);

            if (author) author.points += 1;
        }
    }

    const results = (room.voteOptions || []).map(option => ({
        text: option.text,
        votes: counts.get(option.id) || 0
    })).sort((a, b) => b.votes - a.votes);

    room.phase = "results";

    io.to(room.code).emit("game:results", {
        round: room.round,
        results,
        ranking: ranking(room)
    });

    sendRanking(room);

    setPhaseTimer(room, RESULT_TIME, () => {
        room.round += 1;

        if (room.round > MAX_ROUNDS) {
            endGame(room);
        } else {
            startRound(room);
        }
    });
}

function endGame(room) {
    clearTimer(room);
    room.phase = "ended";

    io.to(room.code).emit("game:ended", {
        ranking: ranking(room)
    });

    sendRanking(room);
}

io.on("connection", socket => {
    console.log("Verbunden:", socket.id);

    socket.on("room:create", async data => {
        if (playerRooms.has(socket.id)) {
            sendError(socket, "Du bist bereits in einem Raum.");
            return;
        }

        const name = typeof data?.name === "string"
            ? data.name.trim()
            : "";

        if (!name || name.length > 20) {
            sendError(socket, "Bitte gib einen Namen mit 1 bis 20 Zeichen ein.");
            return;
        }

        const code = makeCode();

        const room = {
            code,
            hostId: socket.id,
            players: new Map(),
            phase: "lobby",
            round: 1,
            timer: null,
            deadline: null,
            duration: 0,
            voteOptions: [],
            optionAuthors: new Map()
        };

        rooms.set(code, room);

        const origin = socket.handshake.headers.origin;
        let qrCode = null;

        if (origin) {
            try {
                const link = new URL("/", origin);
                link.searchParams.set("room", code);
                qrCode = await QRCode.toDataURL(link.toString());
            } catch (error) {
                console.error("QR-Code-Fehler:", error.message);
            }
        }

        // Der Raum kann während der QR-Erzeugung verändert worden sein.
        if (!rooms.has(code) || !rooms.get(code).players.size) {
            rooms.delete(code);
            return;
        }

        joinRoom(socket, room, name, true, qrCode);
    });

    socket.on("room:join", data => {
        if (playerRooms.has(socket.id)) {
            sendError(socket, "Du bist bereits in einem Raum.");
            return;
        }

        const name = typeof data?.name === "string"
            ? data.name.trim()
            : "";

        const code = typeof data?.code === "string"
            ? data.code.trim()
            : "";

        if (!name || name.length > 20) {
            sendError(socket, "Bitte gib einen Namen mit 1 bis 20 Zeichen ein.");
            return;
        }

        if (!/^\d{6}$/.test(code)) {
            sendError(socket, "Der Raumcode muss sechs Ziffern haben.");
            return;
        }

        const room = rooms.get(code);

        if (!room) {
            sendError(socket, "Dieser Raum existiert nicht.");
            return;
        }

        if (room.phase !== "lobby") {
            sendError(socket, "Das Spiel hat bereits begonnen.");
            return;
        }

        if (room.players.size >= MAX_PLAYERS) {
            sendError(socket, "Der Raum ist voll.");
            return;
        }

        joinRoom(socket, room, name, false);
    });

    socket.on("game:start", () => {
        const room = roomOf(socket);

        if (!room || room.hostId !== socket.id) {
            sendError(socket, "Nur der Host darf das Spiel starten.");
            return;
        }

        if (room.phase !== "lobby") return;

        if (room.players.size < 2) {
            sendError(socket, "Zum Spielen braucht ihr mindestens zwei Spieler.");
            return;
        }

        room.round = 1;
        startRound(room);
    });

    socket.on("game:submitDescription", text => {
        submitDescription(socket, text);
    });

    socket.on("game:vote", optionId => {
        submitVote(socket, optionId);
    });

    socket.on("disconnect", () => {
        const room = roomOf(socket);

        if (!room) return;

        room.players.delete(socket.id);
        playerRooms.delete(socket.id);

        if (room.players.size === 0) {
            clearTimer(room);
            rooms.delete(room.code);
            return;
        }

        if (room.hostId === socket.id) {
            room.hostId = null;
        }

        sendLobby(room);

        // Falls durch einen Abbruch nun alle verbliebenen Spieler
        // fertig sind, wird die aktuelle Phase fortgesetzt.
        if (room.phase === "writing" &&
            [...room.players.values()].every(p => p.submitted)) {
            startVoting(room);
        }

        if (room.phase === "voting" &&
            [...room.players.values()].every(p => p.vote !== null)) {
            finishRound(room);
        }

        sendRanking(room);
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Witzduell läuft auf Port ${PORT}`);
});
