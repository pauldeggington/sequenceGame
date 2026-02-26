/**
 * Sequence P2P Game – Trystero (serverless P2P)
 * ─────────────────────────────────────────────
 * Flow:
 *  1. Setup screen: host generates room → share link → pick teams → start
 *  2. Game screen:  board + hand, no opponent hand shown
 */

// Networking now uses PeerJS loaded via <script> tag in index.html

// ── Constants ─────────────────────────────────────────────────
const BOARD_LAYOUT = [
    ["FREE", "2S", "3S", "4S", "5S", "10D", "QD", "KD", "AD", "FREE"],
    ["6C", "5C", "4C", "3C", "2C", "4S", "5S", "6S", "7S", "AC"],
    ["7C", "AS", "2D", "3D", "4D", "KC", "QC", "10C", "8C", "KC"],
    ["8C", "KS", "6C", "5C", "4C", "9H", "8H", "9C", "9S", "QC"],
    ["9C", "QS", "7C", "6H", "5H", "2H", "7H", "8C", "10S", "10C"],
    ["AS", "7H", "9H", "AH", "4H", "3H", "KH", "10D", "6H", "2D"],
    ["KS", "8H", "8D", "2C", "3C", "10H", "QH", "QD", "5H", "3D"],
    ["QS", "9H", "7D", "6D", "5D", "AC", "AD", "KD", "4H", "4D"],
    ["10S", "10H", "QH", "KH", "AH", "3S", "2S", "2H", "3H", "5D"],
    ["FREE", "9S", "8S", "7S", "6S", "9D", "8D", "7D", "6D", "FREE"]
];

const SUITS = { H: '♥', D: '♦', S: '♠', C: '♣' };
const ONE_EYE = new Set(['JH', 'JS']);
const TWO_EYE = new Set(['JD', 'JC']);
const TEAM_COLORS = ['red', 'blue', 'green'];

function getCardImagePath(card) {
    if (card === 'FREE') return 'card_images/back_light.png';
    const rank = card.slice(0, -1);
    const suit = card.slice(-1);
    const suitMap = { 'H': 'hearts', 'D': 'diamonds', 'S': 'spades', 'C': 'clubs' };
    const suitName = suitMap[suit];

    // Special handling for Jacks based on Sequence logic
    if (rank === 'J') {
        if (card === 'JH') return 'card_images/hearts_J.png';
        if (card === 'JS') return 'card_images/spades_J.png';
        if (card === 'JD') return 'card_images/diamonds_J.png';
        if (card === 'JC') return 'card_images/clubs_J_two_eyed.png';
    }

    return `card_images/${suitName}_${rank}.png`;
}

function genId(len = 8) {
    return Array.from(crypto.getRandomValues(new Uint8Array(len)))
        .map(b => b.toString(36).padStart(2, '0')).join('').slice(0, len);
}

// ── Game Class ────────────────────────────────────────────────
class SequenceGame {
    constructor() {
        this.board = BOARD_LAYOUT;
        this.chips = Array(10).fill(null).map(() => Array(10).fill(null));
        this.deck = [];
        this.hand = [];

        // PeerJS variables
        this.peer = null;
        this.connections = {};
        this.hostConnection = null;

        this.isHost = false;
        this.myColor = null;
        this.currentTurn = null;
        this.selectedCardIndex = null;
        this.sequences = { red: 0, blue: 0, green: 0 };
        this.jackMode = null;
        this.teamCount = 2;
        this.peers = [];         // connected peer IDs
        this.peerNames = {};     // peerId -> name
        this.myName = '';
        this.playerID = localStorage.getItem('sequence_playerID') || genId(12);
        localStorage.setItem('sequence_playerID', this.playerID);

        this.playerIDMap = {};   // peerId -> playerID
        this.playerStates = {};  // playerID -> { color, hand, name, peerId }

        this.initSetup();
    }

    // ══════════════════════════════════════
    // SETUP SCREEN
    // ══════════════════════════════════════
    initSetup() {
        this.ui = {
            status: document.getElementById('setup-status'),
            inviteBox: document.getElementById('invite-box'),
            inviteUrl: document.getElementById('invite-url'),
            teamCfg: document.getElementById('team-config'),
            playerList: document.getElementById('player-list'),
            playersEl: document.getElementById('players-connected'),
            startBtn: document.getElementById('start-game-btn'),
            waitMsg: document.getElementById('waiting-msg'),
            teamLabels: document.getElementById('team-labels'),
            nameInput: document.getElementById('player-name'),
            createSec: document.getElementById('create-game-section'),
            createBtn: document.getElementById('create-game-btn'),
            board: document.getElementById('game-board'),
            hand: document.getElementById('player-hand'),
            turnIndicator: document.getElementById('turn-indicator'),
            logContent: document.getElementById('log-content'),
            jackHint: document.getElementById('jack-hint'),
            redScore: document.getElementById('red-score'),
            blueScore: document.getElementById('blue-score'),
            greenScore: document.getElementById('green-score'),
            greenScoreWrap: document.getElementById('green-score-wrap'),
            myTeamName: document.getElementById('my-team-name'),
            gameOverOverlay: document.getElementById('game-over-overlay'),
            winnerDisplay: document.getElementById('winner-text'),
            playAgainWaiting: document.getElementById('play-again-waiting'),
            playAgainBtn: document.getElementById('play-again-btn'),
            homeBtn: document.getElementById('home-btn'),
            turnOverlay: document.getElementById('turn-overlay'),
            emojiTrigger: document.getElementById('emoji-trigger'),
            emojiMenu: document.getElementById('emoji-menu'),
            emojiFloatContainer: document.getElementById('emoji-float-container'),
            hintsToggle: document.getElementById('show-hints-toggle'),
            deckCountIndicator: document.getElementById('deck-count-indicator'),
        };
        const ui = this.ui;
        const renderSetupState = () => {
            if (!ui.playersEl) return;
            ui.playersEl.innerHTML = '';
            const myDisplay = this.myName || 'You';
            const me = document.createElement('div');
            me.className = 'player-entry me';
            me.innerText = `👤 ${myDisplay}${this.isHost ? ' (Host)' : ''}`;
            ui.playersEl.appendChild(me);

            this.peers.forEach((pid, i) => {
                const el = document.createElement('div');
                el.className = 'player-entry';
                let peerName = this.peerNames[pid];
                if (!peerName) {
                    if (pid === 'HOST') peerName = 'Host';
                    else peerName = `Player ${i + 2}`;
                }
                el.innerText = `👤 ${peerName}`;
                ui.playersEl.appendChild(el);
            });
        };

        this.syncPlayers = () => {
            if (this.isHost) {
                this.broadcast('players_sync', {
                    hostName: this.myName,
                    peers: this.peers,
                    peerNames: this.peerNames
                });
                renderSetupState();
            }
        };

        // Name input
        if (ui.nameInput) {
            ui.nameInput.addEventListener('input', () => {
                this.myName = ui.nameInput.value.trim();
                localStorage.setItem('sequence_playerName', this.myName);
                if (this.isHost) {
                    this.syncPlayers();
                } else {
                    this.sendJoin();
                }
                renderSetupState();
            });
            const savedName = localStorage.getItem('sequence_playerName');
            if (savedName) {
                ui.nameInput.value = savedName;
                this.myName = savedName;
            }
        }

        // ── Actions Setup ──
        this.sendName = (name) => this.broadcast('name', name);
        this.sendJoin = () => this.broadcast('join', { name: this.myName, playerID: this.playerID });
        this.sendConfig = (config) => this.broadcast('config', config);
        this.sendGameStart = (data, pId) => pId ? this.sendTo(pId, 'gameStart', data) : this.broadcast('gameStart', data);
        this.sendMove = (data) => this.broadcast('move', data);
        this.sendSync = (data) => this.broadcast('sync', data);
        this.sendEmoji = (emoji) => this.broadcast('emoji', emoji);

        // Determine room ID and start flow
        const hashId = window.location.hash.substring(1);
        const savedRoomId = localStorage.getItem('sequence_roomID');
        const savedIsHost = localStorage.getItem('sequence_isHost');

        if (hashId && hashId === savedRoomId && savedIsHost === 'true') {
            ui.status.innerText = "Re-hosting room...";
            this.startSession(hashId, true);
        } else if (hashId) {
            ui.status.innerText = "Joining room...";
            this.startSession(hashId, false);
        } else if (savedRoomId && savedIsHost === 'true') {
            ui.createSec.style.display = 'block';
            ui.status.innerText = "Ready to start a game";
        } else {
            ui.createSec.style.display = 'block';
            ui.status.innerText = "Welcome to Very Wild Jacks";
        }

        ui.createBtn.addEventListener('click', () => {
            const newId = genId(8);
            ui.status.innerText = "Creating room...";
            this.startSession(newId, true);
        });

        this.initEventListeners();
    }

    initEventListeners() {
        const ui = this.ui;
        if (!ui) return;

        // Team buttons
        document.querySelectorAll('.team-btn').forEach(btn => {
            btn.onmousedown = () => { // focus fix
                document.querySelectorAll('.team-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                this.teamCount = parseInt(btn.dataset.teams);
                this.updateTeamLabels(ui.teamLabels);
                this.sendConfig({ teamCount: this.teamCount });
            };
        });

        // Start button
        ui.startBtn.onclick = () => this.startGame();

        // Hint toggle
        if (ui.hintsToggle) {
            ui.hintsToggle.onchange = () => {
                this.hintsEnabled = ui.hintsToggle.checked;
                if (this.isHost) {
                    this.sendConfig({ hintsEnabled: this.hintsEnabled });
                }
            };
        }

        // Play Again
        if (ui.playAgainBtn) {
            ui.playAgainBtn.onclick = () => {
                if (this.isHost) {
                    this.startGame();
                } else {
                    if (ui.playAgainWaiting) ui.playAgainWaiting.style.display = 'block';
                    ui.playAgainBtn.style.display = 'none';
                }
            };
        }

        // Home button
        if (ui.homeBtn) {
            ui.homeBtn.onclick = () => {
                window.location.href = window.location.origin + window.location.pathname;
            };
        }

        window.addEventListener("visibilitychange", () => {
            if (document.visibilityState === 'visible' && !this.isHost) {
                if (!this.hostConnection || !this.hostConnection.open) {
                    this.attemptReconnect();
                }
            }
        });
    }

    startSession(roomId, isHost) {
        this.isHost = isHost;
        this.currentRoomId = roomId;
        const ui = this.ui;
        if (!ui) return;

        ui.createSec.style.display = 'none';

        if (isHost && window.location.hash !== '#' + roomId) {
            window.location.hash = roomId;
        }

        localStorage.setItem('sequence_roomID', roomId);
        localStorage.setItem('sequence_isHost', isHost ? 'true' : 'false');

        // Dynamic Meta/Title update
        document.title = `Very Wild Jacks | Room ${roomId}`;
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc) {
            metaDesc.setAttribute('content', `Join my game of Very Wild Jacks! Room ID: ${roomId}. Play Sequence online with friends.`);
        }

        const shareUrl = `${window.location.origin}${window.location.pathname}#${roomId}`;

        // Cleanup old peer if exists
        if (this.peer && !this.peer.destroyed) {
            this.peer.destroy();
        }

        if (this.isHost) {
            const savedStateStr = localStorage.getItem(`sequence_gameState_${roomId}`);
            if (savedStateStr) {
                try {
                    const s = JSON.parse(savedStateStr);
                    this.chips = s.chips;
                    this.sequences = s.sequences;
                    this.deck = s.deck;
                    this.currentTurn = s.currentTurn;
                    this.playerStates = s.playerStates;
                    this.colorNames = s.colorNames;
                    this.teamCount = s.teamCount;
                    this.winTarget = s.winTarget;
                    this.hintsEnabled = s.hintsEnabled;
                    this.started = s.started;

                    const myState = this.playerStates[this.playerID];
                    if (myState) {
                        this.hand = myState.hand;
                        this.myColor = myState.color;
                        // Map my peerId if it changed (though host uses roomId)
                        myState.peerId = roomId;
                    }
                    console.log("Restored game state from localStorage");
                } catch (e) {
                    console.error("Failed to restore game state:", e);
                }
            }
        }

        this.peer = new Peer(this.isHost ? roomId : undefined);

        // Connection watchdog: if we don't 'open' within 10s, try a hard restart
        const watchdog = setTimeout(() => {
            if (this.peer && !this.peer.open && !this.peer.destroyed) {
                console.warn("PeerJS open timed out, restarting session...");
                this.startSession(roomId, this.isHost);
            }
        }, 10000);

        this.peer.on('open', (id) => {
            clearTimeout(watchdog);
            if (this.isHost) {
                ui.status.innerText = "Waiting for players...";
                ui.inviteBox.style.display = 'block';
                ui.inviteUrl.value = shareUrl;
                ui.inviteUrl.onmousedown = () => { // using mousedown for quick selection
                    ui.inviteUrl.select();
                    navigator.clipboard.writeText(shareUrl).then(() => {
                        const originalLabel = document.querySelector('.invite-label').innerText;
                        document.querySelector('.invite-label').innerText = '📋 Copied to clipboard!';
                        document.querySelector('.invite-label').style.color = 'var(--gold)';
                        setTimeout(() => {
                            document.querySelector('.invite-label').innerText = originalLabel;
                            document.querySelector('.invite-label').style.color = '';
                        }, 2000);
                    });
                };
                ui.teamCfg.style.display = 'block';
                this.updateTeamLabels(ui.teamLabels);
                if (this.syncPlayers) this.syncPlayers();

                if (this.started) {
                    this.showGameScreen();
                    this.log("🔄 Session resumed. Waiting for players to reconnect...");
                }
            } else {
                console.log("Attempting to join session:", roomId);
                this.connectToHost(roomId);
            }
        });

        this.peer.on('disconnected', () => {
            console.log("Disconnected from signaling server. Reconnecting...");
            ui.status.innerText = "Connection lost. Reconnecting...";
            this.peer.reconnect();
        });

        if (this.isHost) {
            this.peer.on('connection', (conn) => {
                this.setupConnection(conn);
            });
        }

        this.peer.on('error', (err) => {
            console.error("PeerJS Network Error:", err);
            if (!this.isHost) {
                if (err.type === 'peer-unavailable') {
                    ui.status.innerText = "Host room not found. Retrying in 5s...";
                } else {
                    ui.status.innerText = "Network error: " + err.type;
                }
                setTimeout(() => this.attemptReconnect(), 5000);
            } else {
                if (err.type === 'identity-taken') {
                    ui.status.innerText = "ID Taken. Re-initializing...";
                    setTimeout(() => this.startSession(roomId, true), 3000);
                } else {
                    ui.status.innerText = "Network Error: " + err.type;
                }
            }
        });
    }

    handleData(type, data, peerId) {
        const ui = this.ui;
        if (type === 'join') {
            if (this.isHost) {
                const { name, playerID } = data;
                this.playerIDMap[peerId] = playerID;
                this.peerNames[peerId] = name;

                // Check for reconnection
                if (this.started && this.playerStates[playerID]) {
                    const state = this.playerStates[playerID];
                    state.peerId = peerId;
                    this.sendTo(peerId, 'gameStart', {
                        deck: [...this.deck],
                        myHand: state.hand,
                        myColor: state.color,
                        currentTurn: this.currentTurn,
                        teamCount: this.teamCount,
                        winTarget: this.winTarget,
                        colorNames: this.colorNames,
                        hintsEnabled: this.hintsEnabled,
                        boardChips: this.chips,
                        sequences: this.sequences
                    });
                    this.log(`♻️ ${name} reconnected.`);
                }
                this.syncPlayers();
            }
        } else if (type === 'name') {
            if (this.isHost) {
                this.peerNames[peerId] = data;
                this.syncPlayers();
            }
        } else if (type === 'players_sync') {
            if (!this.isHost) {
                this.peers = data.peers.filter(id => id !== this.peer.id);
                if (!this.peers.includes('HOST')) this.peers.unshift('HOST');
                this.peerNames = data.peerNames;
                this.peerNames['HOST'] = data.hostName ? data.hostName + " (Host)" : "Host";
                if (this.syncPlayers) this.syncPlayers(); // triggers renderstate
            }
        } else if (type === 'config' && !this.isHost) {
            if (data.teamCount) {
                this.teamCount = data.teamCount;
                document.querySelectorAll('.team-btn').forEach(btn => {
                    btn.classList.toggle('selected', parseInt(btn.dataset.teams) === this.teamCount);
                });
                this.updateTeamLabels(ui ? ui.teamLabels : null);
            }
            if (data.hintsEnabled !== undefined) {
                this.hintsEnabled = data.hintsEnabled;
                const toggle = document.getElementById('show-hints-toggle');
                if (toggle) toggle.checked = this.hintsEnabled;
            }
            if (ui) {
                ui.teamCfg.style.display = 'block';
                ui.playerList.style.display = 'block';
            }
        } else if (type === 'gameStart') {
            this.chips = Array(10).fill(null).map(() => Array(10).fill(null));
            this.sequences = { red: 0, blue: 0, green: 0 };
            document.getElementById('game-over-overlay').style.display = 'none';
            document.getElementById('play-again-waiting').style.display = 'none';

            this.deck = data.deck;
            this.hand = data.myHand;
            this.myColor = data.myColor;
            this.currentTurn = data.currentTurn;
            this.teamCount = data.teamCount;
            this.winTarget = data.winTarget || (this.teamCount === 3 ? 1 : 2);
            this.colorNames = data.colorNames || {};
            this.hintsEnabled = data.hintsEnabled || false;
            this.started = true;
            this.showGameScreen();

            if (data.boardChips) {
                this.chips = data.boardChips;
                this.sequences = data.sequences || { red: 0, blue: 0, green: 0 };
                this.renderBoard();
                this.updateScoreUI();
            }
        } else if (type === 'move') {
            this.applyOpponentMove(data, peerId);
            this.currentTurn = data.nextTurn;
            this.updateTurnUI();
            if (this.isHost) {
                this.broadcast('move', data, peerId);
                this.saveGameState();
            }
        } else if (type === 'sync') {
            this.sequences = data.sequences;
            this.updateScoreUI();
            this.renderBoard();
            if (data.winner) {
                this.currentTurn = null;
                this.showWinPopup(data.winner);
            }
        } else if (type === 'emoji') {
            this.showEmojiFloat(data);
            if (this.isHost) this.broadcast('emoji', data, peerId);
        }
    }



    connectToHost(hostID) {
        if (!this.peer || this.peer.destroyed) return;

        console.log("Connecting to host:", hostID);
        const newConn = this.peer.connect(hostID, { reliable: true });

        // Host handshake watchdog
        const handshakeTimeout = setTimeout(() => {
            if (newConn && !newConn.open) {
                console.warn("Host connection handshake timed out, retrying...");
                newConn.close();
                this.attemptReconnect();
            }
        }, 8000);

        newConn.on('open', () => clearTimeout(handshakeTimeout));

        this.hostConnection = newConn;
        this.setupConnection(newConn);
    }

    attemptReconnect() {
        if (this._reconnecting) return;
        this._reconnecting = true;

        const roomID = window.location.hash.substring(1);
        if (!roomID) {
            this._reconnecting = false;
            return;
        }

        const ui = this.ui;
        if (ui) ui.status.innerText = "Attempting to reconnect...";

        // If the peer object is dead, restart the whole session flow
        if (!this.peer || this.peer.destroyed || this.peer.disconnected) {
            console.log("Peer state dead, restarting session...");
            this.startSession(roomID, this.isHost);
        } else if (!this.isHost) {
            // Peer is alive, just re-connect to host
            console.log("Retrying connection to host...");
            this.connectToHost(roomID);
        }

        // Allow another attempt after a cooldown
        setTimeout(() => { this._reconnecting = false; }, 5000);
    }

    setupConnection(conn) {
        const ui = this.ui;

        conn.on('open', () => {
            if (this.isHost) {
                if (!this.peers.includes(conn.peer)) {
                    this.peers.push(conn.peer);
                }
                this.connections[conn.peer] = conn;

                if (ui) {
                    ui.status.innerText = `${this.peers.length + 1} players connected`;
                    ui.playerList.style.display = 'block';
                    ui.startBtn.style.display = 'block';
                }

                this.sendTo(conn.peer, 'config', { teamCount: this.teamCount, hintsEnabled: this.hintsEnabled });
                if (this.myName) {
                    this.sendTo(conn.peer, 'name', this.myName);
                }

                if (this.started) {
                    const knownName = this.peerNames[conn.peer] || conn.peer;
                    const colorNamesEntry = Object.entries(this.colorNames).find(([color, name]) => name === knownName);
                    let theirColor = colorNamesEntry ? colorNamesEntry[0] : null;

                    if (theirColor && this.hands && this.hands[conn.peer]) {
                        this.sendTo(conn.peer, 'gameStart', {
                            deck: [...this.deck],
                            myHand: this.hands[conn.peer],
                            myColor: theirColor,
                            currentTurn: this.currentTurn,
                            teamCount: this.teamCount,
                            winTarget: this.winTarget,
                            colorNames: this.colorNames,
                            hintsEnabled: this.hintsEnabled,
                            boardChips: this.chips, // Custom field for reconnect
                            sequences: this.sequences
                        });
                    }
                }
                if (!this.peerNames[conn.peer]) {
                    this.peerNames[conn.peer] = 'Player ' + (this.peers.length + 1);
                }
                this.syncPlayers();
            } else {
                if (ui) {
                    ui.status.innerText = "Connected! Waiting for host to start...";
                    ui.waitMsg.style.display = 'block';
                    ui.playerList.style.display = 'block';
                }
                if (this.myName) {
                    this.sendJoin();
                }
            }
        });

        conn.on('data', (payload) => {
            if (payload && payload.type) {
                this.handleData(payload.type, payload.data, conn.peer);
            }
        });

        conn.on('close', () => {
            if (this.isHost) {
                this.peers = this.peers.filter(p => p !== conn.peer);
                delete this.connections[conn.peer];
                const leaverName = this.peerNames[conn.peer] || 'A player';
                delete this.peerNames[conn.peer];
                this.syncPlayers();
                if (this.started) {
                    this.log(`❌ ${leaverName} disconnected.`);
                }
            } else {
                if (ui) ui.status.innerText = "Connection lost. Attempting reconnect...";
                this.attemptReconnect();
            }
        });

        conn.on('error', (err) => {
            console.error("Connection error:", err);
            if (!this.isHost) {
                this.attemptReconnect();
            }
        });
    }

    sendTo(peerId, type, data) {
        if (this.connections[peerId] && this.connections[peerId].open) {
            this.connections[peerId].send({ type, data });
        } else if (!this.isHost && this.hostConnection && this.hostConnection.open) {
            this.hostConnection.send({ type, data });
        }
    }

    broadcast(type, data, excludePeerId = null) {
        if (this.isHost) {
            for (let pid of this.peers) {
                if (pid !== excludePeerId) {
                    this.sendTo(pid, type, data);
                }
            }
        } else {
            if (this.hostConnection && this.hostConnection.open) {
                this.hostConnection.send({ type, data });
            }
        }
    }

    updateTeamLabels(container) {
        const labels = TEAM_COLORS.slice(0, this.teamCount);
        const emojis = { red: '🔴 Red', blue: '🔵 Blue', green: '🟢 Green' };
        container.innerHTML = labels.map(c =>
            `<span class="team-tag ${c}">${emojis[c]}</span>`
        ).join('');
    }

    // ══════════════════════════════════════
    // STARTING THE GAME
    // ══════════════════════════════════════
    startGame() {
        if (this.peers.length < 1) {
            alert('Need at least 2 players to start!');
            return;
        }

        this.deck = this.createDeck();
        this.shuffle(this.deck);

        const colors = TEAM_COLORS.slice(0, this.teamCount);
        const totalPlayers = this.peers.length + 1;
        const cardsPerPlayer = totalPlayers <= 2 ? 7 : totalPlayers <= 4 ? 6 : 5;
        this.winTarget = (totalPlayers > 2 && this.teamCount === 3) ? 1 : 2;

        const assignments = [];
        assignments.push({ peerId: null, playerID: this.playerID, color: colors[0], name: this.myName || 'Host' });
        this.peers.forEach((pid, i) => {
            assignments.push({
                peerId: pid,
                playerID: this.playerIDMap[pid] || 'unknown-' + pid,
                color: colors[(i + 1) % colors.length],
                name: this.peerNames[pid] || 'Player ' + (i + 2)
            });
        });

        // Build color → name map
        this.colorNames = {};
        assignments.forEach(a => {
            this.colorNames[a.color] = a.name;
        });

        // Deal hands and store in playerStates
        this.playerStates = {};
        assignments.forEach(a => {
            const hand = this.deck.splice(0, cardsPerPlayer);
            this.playerStates[a.playerID] = {
                color: a.color,
                hand: hand,
                name: a.name,
                peerId: a.peerId
            };
        });

        // Host setup
        const hostState = this.playerStates[this.playerID];
        this.hand = hostState.hand;
        this.myColor = hostState.color;
        this.currentTurn = colors[0];
        this.started = true;

        // Send to each peer
        assignments.forEach(a => {
            if (a.peerId) {
                const pState = this.playerStates[a.playerID];
                this.sendGameStart({
                    deck: [...this.deck],
                    myHand: pState.hand,
                    myColor: pState.color,
                    currentTurn: colors[0],
                    teamCount: this.teamCount,
                    winTarget: this.winTarget,
                    colorNames: this.colorNames,
                    hintsEnabled: this.hintsEnabled
                }, a.peerId);
            }
        });

        this.turnOrder = assignments.map(a => a.color);

        // Host reset overlay
        const ui = this.ui;
        if (ui.gameOverOverlay) ui.gameOverOverlay.style.display = 'none';
        if (ui.playAgainWaiting) ui.playAgainWaiting.style.display = 'none';
        if (ui.playAgainBtn) ui.playAgainBtn.style.display = 'inline-block';

        this.chips = Array(10).fill(null).map(() => Array(10).fill(null));
        this.sequences = { red: 0, blue: 0, green: 0 };

        this.showGameScreen();
    }

    showGameScreen() {
        const ui = this.ui; // Show UI for game
        ui.setupScreen = document.getElementById('setup-screen');
        ui.gameScreen = document.getElementById('game-screen');
        ui.setupScreen.style.display = 'none';
        ui.gameScreen.style.display = 'block';

        if (this.teamCount >= 3) ui.greenScoreWrap.style.display = 'inline';

        const teamLabelMap = { red: '🔴 Red', blue: '🔵 Blue', green: '🟢 Green' };
        if (ui.myTeamName && this.myColor) {
            ui.myTeamName.innerHTML = `<span class="team-tag ${this.myColor}" style="padding: 2px 8px;">${teamLabelMap[this.myColor]}</span>`;
        }

        this.initGameElements();
        this.renderBoard();
        this.renderHand(true);
        this.updateTurnUI();
        this.updateScoreUI();

        this.log(`🎨 ${this.myName || 'Player'} on team ${this.myColor.toUpperCase()}`);
        this.log(`🃏 Cards dealt! ${this.currentTurn} goes first.`);
    }

    initGameElements() {
        const ui = this.ui;
        if (ui.emojiTrigger && ui.emojiMenu) {
            ui.emojiTrigger.onclick = (e) => {
                e.stopPropagation();
                ui.emojiMenu.style.display = ui.emojiMenu.style.display === 'none' ? 'block' : 'none';
            };
            document.querySelectorAll('.emoji-opt').forEach(opt => {
                opt.onclick = (e) => {
                    e.stopPropagation();
                    this.sendEmoji(opt.innerText);
                    this.showEmojiFloat(opt.innerText);
                };
            });
            document.addEventListener('click', () => ui.emojiMenu.style.display = 'none');
            ui.emojiMenu.onclick = (e) => e.stopPropagation();
        }
    }

    createDeck() {
        const suits = ['H', 'D', 'S', 'C'];
        const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'Q', 'K', 'A', 'J'];
        const deck = [];
        for (let i = 0; i < 2; i++)
            for (const suit of suits)
                for (const rank of ranks)
                    deck.push(rank + suit);
        return deck;
    }

    shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
    }

    // ══════════════════════════════════════
    // RENDERING
    // ══════════════════════════════════════
    renderBoard(forceFullRedraw = false) {
        const ui = this.ui;
        if (!ui.board) return;

        if (!forceFullRedraw && ui.board.children.length === 100) {
            this.syncBoardState();
            return;
        }

        ui.board.innerHTML = '';
        for (let r = 0; r < 10; r++) {
            for (let c = 0; c < 10; c++) {
                const val = this.board[r][c];
                const cell = document.createElement('div');
                const chip = this.chips[r][c];

                cell.className = this.calculateCellClass(r, c);

                if (val === 'FREE') {
                    const freeEl = document.createElement('div');
                    freeEl.className = 'cell-card-simple free-space';
                    freeEl.innerText = '★';
                    cell.appendChild(freeEl);
                } else {
                    const suit = val.slice(-1);
                    const simpleCard = document.createElement('div');
                    simpleCard.className = `cell-card-simple ${suit === 'H' || suit === 'D' ? 'red-suit' : 'black-suit'}`;

                    const rankEl = document.createElement('div');
                    rankEl.className = 'simple-rank';
                    rankEl.innerText = val.slice(0, -1);

                    const suitEl = document.createElement('div');
                    suitEl.className = 'simple-suit';
                    suitEl.innerText = SUITS[suit];

                    simpleCard.appendChild(rankEl);
                    simpleCard.appendChild(suitEl);
                    cell.appendChild(simpleCard);
                }

                if (chip) {
                    const chipEl = document.createElement('div');
                    chipEl.className = `chip ${chip}`;
                    cell.appendChild(chipEl);
                }

                cell.onclick = () => this.handleCellClick(r, c);
                ui.board.appendChild(cell);
            }
        }
    }

    calculateCellClass(r, c) {
        const val = this.board[r][c];
        const chip = this.chips[r][c];
        let highlight = '';

        if (this.jackMode === 'one-eye' && chip && chip !== this.myColor) highlight = ' highlight-remove';
        if (this.jackMode === 'two-eye' && !chip && val !== 'FREE') highlight = ' highlight-place';

        if (this.hintsEnabled && !this.jackMode && this.currentTurn === this.myColor) {
            const selectedCard = this.selectedCardIndex !== null ? this.hand[this.selectedCardIndex] : null;
            const hoveredCard = this.hoveredCardIndex !== null ? this.hand[this.hoveredCardIndex] : null;
            if ((val === selectedCard || val === hoveredCard) && !chip) highlight = ' highlight-hint';
        }

        return `cell${val === 'FREE' ? ' free' : ''}${highlight}`;
    }

    syncBoardState() {
        const ui = this.ui;
        for (let r = 0; r < 10; r++) {
            for (let c = 0; c < 10; c++) {
                const cell = ui.board.children[r * 10 + c];
                const chip = this.chips[r][c];

                const targetClass = this.calculateCellClass(r, c);
                if (cell.className !== targetClass) cell.className = targetClass;

                let chipEl = cell.querySelector('.chip');
                if (chip) {
                    if (!chipEl) {
                        chipEl = document.createElement('div');
                        cell.appendChild(chipEl);
                    }
                    const chipClass = `chip ${chip}`;
                    if (chipEl.className !== chipClass) chipEl.className = chipClass;
                } else if (chipEl) {
                    chipEl.remove();
                }
            }
        }
    }

    renderHand(animate = false) {
        const ui = this.ui;
        if (!ui.hand) return;
        ui.hand.innerHTML = '';
        this.hand.forEach((card, index) => {
            const isOneEye = ONE_EYE.has(card);
            const isTwoEye = TWO_EYE.has(card);

            const cardEl = document.createElement('div');
            cardEl.className = [
                'card',
                this.selectedCardIndex === index ? 'selected' : '',
                isOneEye ? 'jack-one-eye' : '',
                isTwoEye ? 'jack-two-eye' : '',
                animate ? 'dealing' : ''
            ].filter(Boolean).join(' ');

            if (animate) {
                cardEl.style.animationDelay = `${index * 0.1}s`;
            }

            const img = document.createElement('img');
            img.src = getCardImagePath(card);
            img.className = 'hand-card-img';
            cardEl.appendChild(img);

            if (isOneEye || isTwoEye) {
                const badge = document.createElement('span');
                badge.className = 'jack-badge';
                badge.innerText = isOneEye ? '👁' : '👁👁';
                cardEl.appendChild(badge);
            }

            cardEl.onpointerdown = (e) => {
                if (this.currentTurn !== this.myColor) return;
                // prevent selection ghosting/drag
                if (e.pointerType === 'touch') e.preventDefault();

                // Check if card is dead (no empty spots left on the board)
                if (!isOneEye && !isTwoEye) {
                    let dead = true;
                    for (let r = 0; r < 10; r++) {
                        for (let c = 0; c < 10; c++) {
                            if (this.board[r][c] === card && this.chips[r][c] === null) {
                                dead = false;
                                break;
                            }
                        }
                        if (!dead) break;
                    }

                    if (dead) {
                        const newCard = this.deck.length > 0 ? this.deck.shift() : null;
                        this.hand.splice(index, 1);
                        if (newCard) this.hand.push(newCard);

                        const rank = card.slice(0, -1);
                        const suit = card.slice(-1);
                        const cardName = rank + SUITS[suit];

                        this.log(`♻️ Exchanged dead card: ${cardName}`);

                        if (this.sendMove) {
                            this.sendMove({
                                row: 0, col: 0,
                                color: this.myColor,
                                moveType: 'exchange',
                                drew: newCard !== null,
                                nextTurn: this.myColor, // Still my turn
                                cardName
                            });
                        }

                        this.selectedCardIndex = null;
                        this.jackMode = null;
                        this.renderHand();
                        this.renderBoard();
                        this.updateJackHint();
                        // Turn continues
                        return;
                    }
                }

                this.selectedCardIndex = index;
                this.jackMode = isOneEye ? 'one-eye' : isTwoEye ? 'two-eye' : null;
                this.renderHand();
                this.renderBoard();
                this.updateJackHint();
            };

            cardEl.onpointerenter = () => {
                this.hoveredCardIndex = index;
                if (this.currentTurn === this.myColor && this.hintsEnabled) {
                    this.syncBoardState();
                }
                this.updateDeckCountIndicator(card);
            };

            cardEl.onpointerleave = () => {
                if (this.hoveredCardIndex === index) {
                    this.hoveredCardIndex = null;
                    if (this.currentTurn === this.myColor && this.hintsEnabled) {
                        this.syncBoardState();
                    }
                    if (ui.deckCountIndicator) ui.deckCountIndicator.style.visibility = 'visible';
                }
            };

            ui.hand.appendChild(cardEl);
        });
    }


    updateDeckCountIndicator(card) {
        const ui = this.ui;
        if (!ui.deckCountIndicator) return;

        const isOneEye = ONE_EYE.has(card);
        const isTwoEye = TWO_EYE.has(card);

        let openSlots = 0;
        let infoText = "";

        if (isOneEye) {
            // One-eyed Jack: removable opponent chips
            for (let r = 0; r < 10; r++) {
                for (let c = 0; c < 10; c++) {
                    const chip = this.chips[r][c];
                    if (chip && chip !== this.myColor) openSlots++;
                }
            }
            infoText = `🎯 ${openSlots} opponent chips removable`;
        } else if (isTwoEye) {
            // Two-eyed Jack: any empty non-free space
            for (let r = 0; r < 10; r++) {
                for (let c = 0; c < 10; c++) {
                    if (this.board[r][c] !== 'FREE' && this.chips[r][c] === null) openSlots++;
                }
            }
            infoText = `✨ WILD: ${openSlots} empty spaces available`;
        } else {
            // Normal card: matching empty slots
            for (let r = 0; r < 10; r++) {
                for (let c = 0; c < 10; c++) {
                    if (this.board[r][c] === card && this.chips[r][c] === null) openSlots++;
                }
            }
            const rank = card.slice(0, -1);
            const suit = card.slice(-1);
            const cardName = rank + SUITS[suit];
            infoText = `📍 ${openSlots} open ${cardName} slot${openSlots === 1 ? '' : 's'} on board`;
        }

        ui.deckCountIndicator.innerText = infoText;
        ui.deckCountIndicator.style.display = 'block';
    }

    updateJackHint() {
        const ui = this.ui;
        if (!ui.jackHint) return;
        if (this.jackMode === 'one-eye') {
            ui.jackHint.innerText = "👁 One-Eyed Jack: Click an opponent's chip to remove it.";
            ui.jackHint.style.display = 'block';
        } else if (this.jackMode === 'two-eye') {
            ui.jackHint.innerText = "👁👁 Two-Eyed Jack: Click any empty cell to place your chip.";
            ui.jackHint.style.display = 'block';
        } else {
            ui.jackHint.style.display = 'none';
        }
    }

    updateScoreUI() {
        const ui = this.ui;
        if (ui.redScore) ui.redScore.innerText = this.sequences.red;
        if (ui.blueScore) ui.blueScore.innerText = this.sequences.blue;
        if (this.teamCount >= 3 && ui.greenScore) {
            ui.greenScore.innerText = this.sequences.green;
        }
    }

    // ══════════════════════════════════════
    // MOVE HANDLING
    // ══════════════════════════════════════
    handleCellClick(r, c) {
        if (this.currentTurn !== this.myColor) return;
        if (this.selectedCardIndex === null) return;

        const card = this.hand[this.selectedCardIndex];
        const cellVal = this.board[r][c];
        const isFree = cellVal === 'FREE';
        const chip = this.chips[r][c];

        let moveType = null;

        if (ONE_EYE.has(card)) {
            if (chip && chip !== this.myColor) {
                moveType = 'remove';
            } else {
                this.log("⚠ One-eyed Jack: Click an opponent's chip.");
                return;
            }
        } else if (TWO_EYE.has(card)) {
            if (!chip && !isFree) {
                moveType = 'place';
            } else {
                this.log("⚠ Two-eyed Jack: Click any empty space.");
                return;
            }
        } else {
            if (!isFree && card === cellVal && !chip) {
                moveType = 'place';
            } else {
                this.log("⚠ Card doesn't match this cell.");
                return;
            }
        }

        // Apply locally
        this.chips[r][c] = moveType === 'place' ? this.myColor : null;

        const drawnCard = this.deck.length > 0 ? this.deck.shift() : null;
        this.hand.splice(this.selectedCardIndex, 1);
        if (drawnCard) this.hand.push(drawnCard);

        // Update host state
        if (this.isHost && this.playerStates[this.playerID]) {
            this.playerStates[this.playerID].hand = [...this.hand];
        }

        // Calculate next turn
        const colors = TEAM_COLORS.slice(0, this.teamCount);
        const myIdx = colors.indexOf(this.myColor);
        const nextTurn = colors[(myIdx + 1) % colors.length];

        // Card name for log
        const cellRank = cellVal.slice(0, -1);
        const cellSuit = cellVal.slice(-1);
        const cardName = cellRank + SUITS[cellSuit];
        const myName = (this.colorNames && this.colorNames[this.myColor]) || this.myColor;
        this.log(`${moveType === 'place' ? '✅' : '❌'} ${myName} ${moveType === 'place' ? 'placed on' : 'removed from'} ${cardName}`);

        // Tell opponents
        this.sendMove({
            row: r, col: c,
            color: this.myColor,
            moveType,
            drew: drawnCard !== null,
            nextTurn,
            cardName,
            newHand: this.hand // Send new hand for host tracking
        });

        this.selectedCardIndex = null;
        this.jackMode = null;
        this.hoveredCardIndex = null;
        this.currentTurn = nextTurn;

        this.renderHand();
        this.renderBoard();
        this.updateTurnUI();
        this.updateJackHint();
        this.checkSequences();
    }

    applyOpponentMove(data, peerId) {
        const { row, col, color, moveType, drew, cardName, nextTurn, newHand } = data;

        if (this.isHost && peerId) {
            const playerID = this.playerIDMap[peerId];
            if (playerID && this.playerStates[playerID]) {
                if (newHand) this.playerStates[playerID].hand = newHand;
                else if (drew && this.deck.length > 0) {
                    // Backwards compatibility if hand not sent
                    this.deck.shift();
                }
            }
        }

        if (moveType === 'exchange') {
            if (drew && !newHand && this.deck.length > 0) this.deck.shift();
            const name = (this.colorNames && this.colorNames[color]) || color;
            this.log(`♻️ ${name} exchanged dead card: ${cardName}`);
            if (this.isHost) this.saveGameState();
            return; // Turn continues for them
        }

        this.chips[row][col] = moveType === 'place' ? color : null;
        if (drew && !newHand && this.deck.length > 0) this.deck.shift();

        const name = (this.colorNames && this.colorNames[color]) || color;
        const displayCard = cardName || `[${row},${col}]`;
        this.log(`${moveType === 'place' ? '✅' : '❌'} ${name} ${moveType === 'place' ? 'placed on' : 'removed from'} ${displayCard}`);
        this.renderBoard();
        this.checkSequences();
    }

    // ══════════════════════════════════════
    // SEQUENCE DETECTION
    // ══════════════════════════════════════
    checkSequences() {
        let updated = false;
        const colors = TEAM_COLORS.slice(0, this.teamCount);

        for (const color of colors) {
            const count = this.countSequencesForColor(color);
            if (count > this.sequences[color]) {
                this.sequences[color] = count;
                this.log(`🎉 ${color} formed sequence #${count}!`);
                this.showSequencePopup(color);
                updated = true;
            }
        }

        this.updateScoreUI();

        const winTarget = this.winTarget || (this.teamCount === 3 ? 1 : 2);
        const winner = colors.find(c => this.sequences[c] >= winTarget) || null;

        if (winner) {
            this.currentTurn = null;
            this.log(`🏆 ${winner} wins!`);
            this.showWinPopup(winner);
        }

        if (updated && this.sendSync) {
            this.sendSync({ sequences: this.sequences, winner });
            if (this.isHost) this.saveGameState();
        }
    }

    saveGameState() {
        if (!this.isHost || !this.started || !this.currentRoomId) return;
        const state = {
            chips: this.chips,
            sequences: this.sequences,
            deck: this.deck,
            currentTurn: this.currentTurn,
            playerStates: this.playerStates,
            colorNames: this.colorNames,
            teamCount: this.teamCount,
            winTarget: this.winTarget,
            hintsEnabled: this.hintsEnabled,
            started: this.started
        };
        localStorage.setItem(`sequence_gameState_${this.currentRoomId}`, JSON.stringify(state));
    }

    countSequencesForColor(color) {
        const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
        const grid = this.chips.map((row, r) =>
            row.map((cell, c) => this.board[r][c] === 'FREE' ? color : cell)
        );
        let count = 0;
        for (let r = 0; r < 10; r++)
            for (let c = 0; c < 10; c++)
                for (const [dr, dc] of directions)
                    if (this.checkLine(grid, r, c, dr, dc, color)) count++;
        return count;
    }

    checkLine(grid, r, c, dr, dc, color) {
        for (let i = 0; i < 5; i++) {
            const nr = r + i * dr, nc = c + i * dc;
            if (nr < 0 || nr >= 10 || nc < 0 || nc >= 10 || grid[nr][nc] !== color) return false;
        }
        return true;
    }

    // ══════════════════════════════════════
    // UI HELPERS
    // ══════════════════════════════════════
    updateTurnUI() {
        const ui = this.ui;
        if (!ui.turnIndicator || !this.currentTurn) return;
        const mine = this.currentTurn === this.myColor;
        if (mine) {
            ui.turnIndicator.innerText = "Your Turn!";
            this.showTurnOverlay();
            if (navigator.vibrate) navigator.vibrate(200);
        } else {
            const name = (this.colorNames && this.colorNames[this.currentTurn]) || this.currentTurn;
            ui.turnIndicator.innerText = `⏳ ${name}'s turn…`;
        }
        ui.turnIndicator.style.color = mine ? "var(--gold)" : "var(--text)";
    }

    showTurnOverlay() {
        const ui = this.ui;
        if (!ui.turnOverlay) return;
        ui.turnOverlay.style.display = 'flex';
        clearTimeout(this._overlayTimer);
        this._overlayTimer = setTimeout(() => {
            ui.turnOverlay.style.display = 'none';
        }, 1200);
    }

    showWinPopup(winner) {
        const ui = this.ui;
        if (ui.gameOverOverlay && ui.winnerDisplay) { // Note: winnerDisplay might be wrong ID based on view, let me check
            ui.winnerDisplay.innerText = `${winner.toUpperCase()} TEAM WINS!`;
            ui.winnerDisplay.style.color = winner === 'red' ? '#ff7675' : (winner === 'blue' ? '#74b9ff' : '#55efc4');
            ui.gameOverOverlay.style.display = 'flex';
        }
    }

    showSequencePopup(color) {
        const overlay = document.getElementById('sequence-popup-overlay');
        const subtitle = document.getElementById('seq-popup-subtitle');
        if (!overlay || !subtitle) return;

        const teamName = color.charAt(0).toUpperCase() + color.slice(1);
        const teamColors = { red: '#ff7675', blue: '#74b9ff', green: '#55efc4' };

        subtitle.innerHTML = `<span style="color: ${teamColors[color] || 'white'}; font-weight: bold;">${teamName} Team</span> completed a sequence!`;

        // Remove existing animation and trigger reflow
        overlay.style.animation = 'none';
        overlay.offsetHeight; /* trigger reflow */
        overlay.style.animation = null;

        overlay.style.display = 'flex';

        clearTimeout(this._seqPopupTimer);
        this._seqPopupTimer = setTimeout(() => {
            overlay.style.display = 'none';
        }, 3000);
    }

    showEmojiFloat(emoji) {
        const ui = this.ui;
        if (!ui.emojiFloatContainer) return;

        const el = document.createElement('div');
        el.className = 'floating-emoji';
        el.innerText = emoji;

        const left = 20 + Math.random() * 60;
        el.style.left = left + '%';
        el.style.bottom = '20px';

        ui.emojiFloatContainer.appendChild(el);
        setTimeout(() => el.remove(), 3000);
    }

    log(msg) {
        const ui = this.ui;
        if (!ui.logContent) return;
        const el = document.createElement('div');
        el.className = 'log-entry';
        el.innerText = msg;
        ui.logContent.appendChild(el);

        const container = document.getElementById('game-log');
        if (container) {
            container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
        }
    }
}

// ── Boot ──
new SequenceGame();
