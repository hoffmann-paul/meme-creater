
const socket = io();

const $ = id => document.getElementById(id);

let myRoom = null;
let isHost = false;
let submitted = false;
let voted = false;
let currentPhase = null;
let timerInterval = null;
let phaseDeadline = null;

const startBereich = $("startBereich");
const warteBereich = $("warteBereich");
const spielBereich = $("spielBereich");

function message(text) {
    $("meldung").textContent = text || "";
}

function showGame() {
    startBereich.hidden = true;
    warteBereich.hidden = true;
    spielBereich.hidden = false;
}

function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function startTimer(deadline) {
    phaseDeadline = deadline;

    if (timerInterval) clearInterval(timerInterval);

    function update() {
        const seconds = Math.max(
            0,
            Math.ceil((phaseDeadline - Date.now()) / 1000)
        );

        $("timer").textContent = formatTime(seconds);

        if (seconds <= 0) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
    }

    update();
    timerInterval = setInterval(update, 250);
}

function addTextElement(parent, tag, text) {
    const element = document.createElement(tag);
    element.textContent = text;
    parent.appendChild(element);
    return element;
}

function getName() {
    const name = $("benutzername").value.trim();

    if (!name || name.length > 20) {
        message("Gib bitte einen Namen mit 1 bis 20 Zeichen ein.");
        return null;
    }

    return name;
}

// Raumcode aus einem QR-Link übernehmen.
const params = new URLSearchParams(window.location.search);
const urlCode = params.get("room");

if (urlCode && /^\d{6}$/.test(urlCode)) {
    $("raumcode").value = urlCode;
}

$("raumErstellen").addEventListener("click", () => {
    const name = getName();
    if (!name) return;

    socket.emit("room:create", { name });
});

$("raumBeitreten").addEventListener("click", () => {
    const name = getName();
    if (!name) return;

    const code = $("raumcode").value.trim();

    if (!/^\d{6}$/.test(code)) {
        message("Der Raumcode muss sechs Ziffern haben.");
        return;
    }

    socket.emit("room:join", { name, code });
});

$("spielStarten").addEventListener("click", () => {
    if (isHost) socket.emit("game:start");
});

$("beschreibungSenden").addEventListener("click", () => {
    if (currentPhase !== "writing" || submitted) return;

    const text = $("beschreibung").value.trim();

    if (!text || text.length > 200) {
        message("Schreibe bitte eine Beschreibung mit maximal 200 Zeichen.");
        return;
    }

    socket.emit("game:submitDescription", text);
});

socket.on("room:ready", data => {
    myRoom = data.code;
    isHost = data.isHost;

    $("codeAnzeige").textContent = data.code;
    $("spielStarten").hidden = !isHost;

    $("qrCode").replaceChildren();

    if (data.qrCode) {
        const img = document.createElement("img");
        img.src = data.qrCode;
        img.alt = "QR-Code zum Beitreten";
        $("qrCode").appendChild(img);
    }

    startBereich.hidden = true;
    warteBereich.hidden = false;
    spielBereich.hidden = true;

    message("");
});

socket.on("room:players", data => {
    const list = $("spielerListe");
    list.replaceChildren();

    for (const player of data.players) {
        addTextElement(list, "li", player.name);
    }
});

socket.on("game:round", data => {
    showGame();

    currentPhase = "writing";
    submitted = false;
    voted = false;

    $("rundenAnzeige").textContent =
        `Runde ${data.round} von ${data.totalRounds}`;

    $("phaseAnzeige").textContent =
        "Schreibe eine witzige Beschreibung!";

    $("schreibBereich").hidden = false;
    $("beschreibung").disabled = false;
    $("beschreibung").value = "";
    $("beschreibungSenden").disabled = false;

    $("abstimmung").hidden = true;
    $("ergebnis").hidden = true;
    $("spielEnde").hidden = true;

    const area = $("bildBereich");
    area.replaceChildren();

    const image = document.createElement("img");
    image.src = data.image;
    image.alt = `Bild für Runde ${data.round}`;

    image.addEventListener("error", () => {
        area.textContent = "Bild konnte nicht geladen werden.";
    });

    area.appendChild(image);
});

socket.on("game:phase", data => {
    currentPhase = data.phase;

    if (data.phase === "writing" || data.phase === "voting") {
        startTimer(data.deadline);
    }

    if (data.phase === "writing") {
        $("phaseAnzeige").textContent =
            "Beschreibungsphase – 60 Sekunden";
    }

    if (data.phase === "voting") {
        $("phaseAnzeige").textContent =
            "Abstimmung – 90 Sekunden";
    }
});

socket.on("game:descriptionAccepted", () => {
    submitted = true;
    $("beschreibung").disabled = true;
    $("beschreibungSenden").disabled = true;
    $("phaseAnzeige").textContent =
        "Beschreibung abgeschickt! Warte auf die anderen.";
    message("");
});

socket.on("game:voting", data => {
    currentPhase = "voting";
    voted = false;

    $("schreibBereich").hidden = true;
    $("abstimmung").hidden = false;
    $("ergebnis").hidden = true;
    $("phaseAnzeige").textContent = "Wähle deine Lieblingsbeschreibung.";

    const answers = $("antworten");
    answers.replaceChildren();

    for (const option of data.options) {
        const button = document.createElement("button");
        button.textContent = option.text;

        button.addEventListener("click", () => {
            if (voted || currentPhase !== "voting") return;

            socket.emit("game:vote", option.id);
        });

        answers.appendChild(button);
    }
});

socket.on("game:voteAccepted", () => {
    voted = true;

    for (const button of $("antworten").querySelectorAll("button")) {
        button.disabled = true;
    }

    $("phaseAnzeige").textContent =
        "Stimme abgegeben! Warte auf das Ergebnis.";
    message("");
});

socket.on("game:results", data => {
    currentPhase = "results";

    $("abstimmung").hidden = true;
    $("schreibBereich").hidden = true;
    $("ergebnis").hidden = false;

    $("phaseAnzeige").textContent = "Die Runde ist ausgewertet.";

    const results = $("rundenErgebnis");
    results.replaceChildren();

    for (const item of data.results) {
        addTextElement(
            results,
            "p",
            `${item.text} — ${item.votes} Stimme(n)`
        );
    }

    $("naechsteRunde").textContent =
        data.round < 10
            ? "Die nächste Runde startet gleich."
            : "Das Spiel wird abgeschlossen.";
});

socket.on("game:ranking", data => {
    const list = $("rangliste");
    list.replaceChildren();

    for (const player of data) {
        addTextElement(
            list,
            "li",
            `${player.name}: ${player.points} Punkte`
        );
    }
});

socket.on("game:ended", data => {
    currentPhase = "ended";

    if (timerInterval) clearInterval(timerInterval);

    $("spielEnde").hidden = false;
    $("schreibBereich").hidden = true;
    $("abstimmung").hidden = true;
    $("ergebnis").hidden = true;
    $("phaseAnzeige").textContent = "Alle zehn Runden sind vorbei!";

    if (data.ranking.length > 0) {
        $("gewinner").textContent =
            `Gewonnen hat ${data.ranking[0].name} mit ` +
            `${data.ranking[0].points} Punkten!`;
    } else {
        $("gewinner").textContent = "Es gibt keinen Gewinner.";
    }
});

socket.on("app:error", text => {
    message(text);
});

socket.on("disconnect", () => {
    message("Verbindung verloren. Bitte lade die Seite neu.");
});
