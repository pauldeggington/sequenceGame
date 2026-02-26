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
    ["8C", "KS", "6C", "5C", "4C", "9D", "8H", "9C", "9S", "QC"],
    ["9C", "QS", "7C", "6H", "5H", "2H", "7H", "8H", "10S", "10C"],
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
        this.isSinglePlayer = false; // Add single player flag
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
        this.lastMove = null;    // { r, c } coordinate of last placement
        this.aiTurnTimeout = null;
        this.exchangedThisTurn = false;
        this.sequenceGrid = Array(10).fill(null).map(() => Array(10).fill(false));

        this.initSetup();
        this.initBackgroundCards();

        window.addEventListener('resize', () => {
            if (this.started) this.checkSequences();
        });
    }

    initBackgroundCards() {
        const bgContainer = document.getElementById('bg-cards');
        if (!bgContainer) return;

        // Flatten board layout to get unique cards (excluding FREE)
        const allCards = BOARD_LAYOUT.flat().filter(c => c !== 'FREE');
        const cardCount = 15;

        for (let i = 0; i < cardCount; i++) {
            const card = allCards[Math.floor(Math.random() * allCards.length)];
            const cardEl = document.createElement('div');
            cardEl.className = 'bg-card';
            cardEl.style.backgroundImage = `url(${getCardImagePath(card)})`;
            this.setRandomFloatingStyles(cardEl);
            bgContainer.appendChild(cardEl);
        }

        const colors = ['red', 'blue', 'green'];
        for (let i = 0; i < 12; i++) {
            const tokenEl = document.createElement('div');
            const color = colors[Math.floor(Math.random() * colors.length)];
            tokenEl.className = `bg-token ${color}`;
            this.setRandomFloatingStyles(tokenEl);
            bgContainer.appendChild(tokenEl);
        }
    }

    setRandomFloatingStyles(el) {
        el.style.left = `${Math.random() * 95}%`;
        el.style.top = `${Math.random() * 95}%`;
        el.style.setProperty('--duration', `${20 + Math.random() * 25}s`);
        el.style.setProperty('--delay', `${-Math.random() * 20}s`);
        el.style.setProperty('--rot', `${Math.random() * 360}deg`);
        el.style.setProperty('--x1', `${-100 + Math.random() * 200}px`);
        el.style.setProperty('--y1', `${-100 + Math.random() * 200}px`);
        el.style.setProperty('--x2', `${-100 + Math.random() * 200}px`);
        el.style.setProperty('--y2', `${-100 + Math.random() * 200}px`);
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
            playSingleBtn: document.getElementById('play-single-btn'),
            board: document.getElementById('game-board'),
            hand: document.getElementById('player-hand'),
            turnIndicator: document.getElementById('turn-indicator'),
            logContent: document.getElementById('log-content'),
            jackHint: document.getElementById('jack-hint'),
            deadHint: document.getElementById('dead-hint'),
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
            backBtn: document.getElementById('setup-back-btn'),
            seqLines: document.getElementById('sequence-lines'),
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
            }
            renderSetupState();
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

        if (ui.playSingleBtn) {
            ui.playSingleBtn.addEventListener('click', () => {
                this.isSinglePlayer = true;
                this.teamCount = 2; // Human vs AI
                this.myName = this.myName || "Player";
                this.isHost = true; // Act as host for game logic

                // Set up peers array manually (empty peer for the AI)
                this.peers = [];
                this.peerNames = {};
                this.playerIDMap = {};

                // Show options instead of starting
                ui.createSec.style.display = 'none';
                ui.teamCfg.style.display = 'block';
                ui.teamCfg.classList.add('single-player-setup');
                ui.startBtn.style.display = 'block';
                ui.backBtn.style.display = 'block';

                // Allow team selection for 1v1 or 1v1v1
                this.updateTeamLabels(ui.teamLabels);
            });
        }

        this.initEventListeners();
    }

    initEventListeners() {
        const ui = this.ui;
        if (!ui) return;

        if (ui.backBtn) {
            ui.backBtn.addEventListener('click', () => {
                if (this.isSinglePlayer) {
                    this.isSinglePlayer = false;
                } else if (this.isHost) {
                    if (this.peer) {
                        this.peer.destroy();
                        this.peer = null;
                    }
                    window.location.hash = '';
                    localStorage.removeItem('sequence_roomID');
                    localStorage.removeItem('sequence_isHost');
                }

                // Reset UI state
                ui.createSec.style.display = 'block';
                ui.teamCfg.style.display = 'none';
                ui.inviteBox.style.display = 'none';
                ui.startBtn.style.display = 'none';
                ui.playerList.style.display = 'none';
                ui.backBtn.style.display = 'none';
                ui.status.innerText = "Welcome to Very Wild Jacks";
                ui.teamCfg.classList.remove('single-player-setup');

                // Reset peers list
                this.peers = [];
                this.peerNames = {};
                this.playerIDMap = {};
                if (this.ui.playersEl) this.ui.playersEl.innerHTML = '';
            });
        }

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
                    this.lastMove = s.lastMove || null;
                    this.sequenceGrid = s.sequenceGrid || Array(10).fill(null).map(() => Array(10).fill(false));

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
                ui.backBtn.style.display = 'block';
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
                        sequences: this.sequences,
                        sequenceGrid: this.sequenceGrid,
                        lastMove: this.lastMove
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
            this.lastMove = data.lastMove || null;
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
                this.sequenceGrid = data.sequenceGrid || Array(10).fill(null).map(() => Array(10).fill(false));
                this.lastMove = data.lastMove || null;
                this.renderBoard();
                this.updateScoreUI();
            }
        } else if (type === 'move') {
            this.applyOpponentMove(data, peerId);
            if (data.moveType === 'place') {
                this.lastMove = { r: data.row, c: data.col };
            } else if (data.moveType === 'remove') {
                this.lastMove = null;
            }
            this.currentTurn = data.nextTurn;
            this.updateTurnUI();
            if (this.isHost) {
                this.broadcast('move', data, peerId);
                this.saveGameState();
            }
        } else if (type === 'sync') {
            this.sequences = data.sequences;
            if (data.sequenceGrid) this.sequenceGrid = data.sequenceGrid;
            this.updateScoreUI();
            this.renderBoard();
            if (data.winner) {
                this.currentTurn = null;
                this.showWinPopup(data.winner);
            }
            if (this.isHost) {
                this.broadcast('sync', data, peerId);
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
                            sequences: this.sequences,
                            lastMove: this.lastMove
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
        if (this.isSinglePlayer) return;
        if (this.connections[peerId] && this.connections[peerId].open) {
            this.connections[peerId].send({ type, data });
        } else if (!this.isHost && this.hostConnection && this.hostConnection.open) {
            this.hostConnection.send({ type, data });
        }
    }

    broadcast(type, data, excludePeerId = null) {
        if (this.isSinglePlayer) return;
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
        if (!this.isSinglePlayer && this.peers.length < 1) {
            alert('Need at least 2 players to start!');
            return;
        }

        this.deck = this.createDeck();
        this.shuffle(this.deck);

        const colors = TEAM_COLORS.slice(0, this.teamCount);
        const assignments = [];
        assignments.push({ peerId: null, playerID: this.playerID, color: colors[0], name: this.myName || 'Host' });

        if (this.isSinglePlayer) {
            // Add automated computers for remaining teams
            for (let i = 1; i < this.teamCount; i++) {
                const botId = `bot-${i}`;
                const botPeer = `COMPUTER_${i}`;
                assignments.push({
                    peerId: botPeer,
                    playerID: botId,
                    color: colors[i],
                    name: 'Computer'
                });
                this.peerNames[botPeer] = 'Computer';
                this.playerIDMap[botPeer] = botId;
            }
            this.peers = assignments.filter(a => a.peerId).map(a => a.peerId);
        } else {
            this.peers.forEach((pid, i) => {
                assignments.push({
                    peerId: pid,
                    playerID: this.playerIDMap[pid] || 'unknown-' + pid,
                    color: colors[(i + 1) % colors.length],
                    name: this.peerNames[pid] || 'Player ' + (i + 2)
                });
            });
        }

        // Deal hands and store in playerStates
        const totalPlayers = assignments.length;
        const cardsPerPlayer = totalPlayers <= 2 ? 7 : totalPlayers <= 4 ? 6 : 5;
        this.winTarget = (totalPlayers > 2 && this.teamCount === 3) ? 1 : 2;

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

        this.chips = Array(10).fill(null).map(() => Array(10).fill(null));
        this.sequences = { red: 0, blue: 0, green: 0 };
        this.lastMove = null;

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
                    hintsEnabled: this.hintsEnabled,
                    lastMove: this.lastMove
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

        // Preserve the SVG if it exists
        const svg = ui.seqLines || document.getElementById('sequence-lines');

        if (!forceFullRedraw && ui.board.querySelectorAll('.cell').length === 100) {
            this.syncBoardState();
            return;
        }

        ui.board.innerHTML = '';
        if (svg) ui.board.appendChild(svg);

        for (let r = 0; r < 10; r++) {
            for (let c = 0; c < 10; c++) {
                const val = this.board[r][c];
                const cell = document.createElement('div');
                cell.id = `cell-${r}-${c}`;
                const chip = this.chips[r][c];

                cell.className = `cell ${this.calculateCellClass(r, c)}`;

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
                    const isLocked = this.sequenceGrid && this.sequenceGrid[r][c];
                    chipEl.className = `chip ${chip}${isLocked ? ' locked' : ''}`;
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

        return `${val === 'FREE' ? ' free' : ''}${highlight}`;
    }

    syncBoardState() {
        const ui = this.ui;
        for (let r = 0; r < 10; r++) {
            for (let c = 0; c < 10; c++) {
                const cell = document.getElementById(`cell-${r}-${c}`);
                if (!cell) continue;
                const chip = this.chips[r][c];

                const targetClass = `cell ${this.calculateCellClass(r, c)}`;
                if (cell.className !== targetClass) cell.className = targetClass;

                let chipEl = cell.querySelector('.chip');
                if (chip) {
                    if (!chipEl) {
                        chipEl = document.createElement('div');
                        cell.appendChild(chipEl);
                    }
                    const isLastMove = this.lastMove && this.lastMove.r === r && this.lastMove.c === c;
                    const isLocked = this.sequenceGrid && this.sequenceGrid[r][c];
                    const chipClass = `chip ${chip}${isLastMove ? ' last-move' : ''}${isLocked ? ' locked' : ''}`;
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
        let hasAnyDead = false;
        this.hand.forEach((card, index) => {
            const isOneEye = ONE_EYE.has(card);
            const isTwoEye = TWO_EYE.has(card);
            let isDead = false;

            if (!isOneEye && !isTwoEye && this.board && this.chips) {
                isDead = true;
                for (let r = 0; r < 10; r++) {
                    for (let c = 0; c < 10; c++) {
                        if (this.board[r][c] === card && this.chips[r][c] === null) {
                            isDead = false;
                            break;
                        }
                    }
                    if (!isDead) break;
                }
                if (isDead) hasAnyDead = true;
            }

            const cardEl = document.createElement('div');
            if (this.selectedCardIndex === index) {
                this.selectedIsDead = isDead;
            }

            cardEl.className = [
                'card',
                this.selectedCardIndex === index ? 'selected' : '',
                isOneEye ? 'jack-one-eye' : '',
                isTwoEye ? 'jack-two-eye' : '',
                isDead ? 'dead-card' : '',
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
            } else if (isDead) {
                const badge = document.createElement('span');
                badge.className = 'dead-badge';
                badge.innerText = '💀';
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
                        if (this.exchangedThisTurn) {
                            this.log("⚠ Already exchanged a dead card this turn.");
                            return;
                        }

                        const newCard = this.deck.length > 0 ? this.deck.shift() : null;
                        this.hand.splice(index, 1);
                        if (newCard) this.hand.push(newCard);

                        const rank = card.slice(0, -1);
                        const suit = card.slice(-1);
                        const cardName = rank + SUITS[suit];

                        this.log(`♻️ Exchanged dead card: ${cardName}`);
                        this.exchangedThisTurn = true;

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
            };

            cardEl.onpointerleave = () => {
                if (this.hoveredCardIndex === index) {
                    this.hoveredCardIndex = null;
                    if (this.currentTurn === this.myColor && this.hintsEnabled) {
                        this.syncBoardState();
                    }
                }
            };

            ui.hand.appendChild(cardEl);
        });
        this.hasDeadCards = hasAnyDead;
        this.updateJackHint();
    }


    updateJackHint() {
        const ui = this.ui;
        if (!ui.jackHint) return;

        // Jack hints
        if (this.jackMode === 'one-eye') {
            ui.jackHint.innerText = "👁 One-Eyed Jack: Click an opponent's chip to remove it.";
            ui.jackHint.style.display = 'block';
        } else if (this.jackMode === 'two-eye') {
            ui.jackHint.innerText = "👁👁 Two-Eyed Jack: Click any empty cell to place your chip.";
            ui.jackHint.style.display = 'block';
        } else {
            ui.jackHint.style.display = 'none';
        }

        // Dead card hints
        if (ui.deadHint) {
            if (this.selectedIsDead && this.currentTurn === this.myColor) {
                ui.deadHint.innerText = "💀 Dead Card: Click to exchange for a new one.";
                ui.deadHint.style.display = 'block';
            } else {
                ui.deadHint.style.display = 'none';
            }
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
            if (chip && chip !== this.myColor && !this.isChipInSequence(r, c, chip)) {
                moveType = 'remove';
            } else if (chip && chip !== this.myColor) {
                this.log("⚠ Cannot remove a chip from a completed sequence.");
                return;
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
        if (moveType === 'place') {
            this.lastMove = { r, c };
        } else if (moveType === 'remove') {
            this.lastMove = null;
        }

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

        this.checkAndTriggerAITurn();
    }

    checkAndTriggerAITurn() {
        if (this.isSinglePlayer && this.currentTurn) {
            const playerState = Object.values(this.playerStates).find(s => s.color === this.currentTurn);
            if (playerState && playerState.peerId && playerState.peerId.startsWith('COMPUTER_')) {
                // Clear any existing timeout to prevent overlapping turns
                if (this.aiTurnTimeout) clearTimeout(this.aiTurnTimeout);

                this.aiTurnTimeout = setTimeout(() => {
                    this.playAITurn();
                }, 1000); // 1s thinking delay
            }
        }
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

        // Reset and recalculate grid IMMEDIATELY to prevent race conditions with One-Eyed Jacks
        this.sequenceGrid = Array(10).fill(null).map(() => Array(10).fill(false));
        const allSequences = {};

        const winTarget = this.winTarget || (this.teamCount === 3 ? 1 : 2);
        const newlyFormed = [];

        for (const color of colors) {
            const result = this.countSequencesForColor(color);
            allSequences[color] = result.sequences;

            result.sequences.forEach(seq => {
                seq.forEach(cell => {
                    this.sequenceGrid[cell.r][cell.c] = true;
                });
            });

            if (result.count > (this.sequences[color] || 0)) {
                this.sequences[color] = result.count;
                this.log(`🎉 ${color} formed sequence #${result.count}!`);
                newlyFormed.push(color);
                updated = true;
            }
        }

        this.updateScoreUI();

        const winner = colors.find(c => this.sequences[c] >= winTarget) || null;

        if (winner) {
            this.currentTurn = null;
            this.log(`🏆 ${winner} wins!`);
            this.showWinPopup(winner);
        } else {
            // Only show sequence popups if no one has won yet
            newlyFormed.forEach(color => this.showSequencePopup(color));
        }

        if (updated && this.sendSync) {
            this.sendSync({ sequences: this.sequences, winner, sequenceGrid: this.sequenceGrid });
            if (this.isHost) this.saveGameState();
        }

        // Delayed UI line drawing only
        setTimeout(() => {
            if (this.ui.seqLines) {
                this.ui.seqLines.innerHTML = '';
                for (const color of colors) {
                    if (allSequences[color]) {
                        allSequences[color].forEach(seq => this.drawSequenceLine(seq, color));
                    }
                }
            }
        }, 150);
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
            started: this.started,
            lastMove: this.lastMove,
            sequenceGrid: this.sequenceGrid
        };
        localStorage.setItem(`sequence_gameState_${this.currentRoomId}`, JSON.stringify(state));
    }

    countSequencesForColor(color) {
        if (!this.ui.seqLines) return { count: 0, sequences: [] };

        const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
        const grid = this.chips.map((row, r) =>
            row.map((cell, c) => this.board[r][c] === 'FREE' ? color : cell)
        );

        let foundSequences = []; // Array of [{r, c}, ...]
        let usedInSequence = Array(10).fill(null).map(() => Array(10).fill(false));

        for (let r = 0; r < 10; r++) {
            for (let c = 0; c < 10; c++) {
                for (const [dr, dc] of directions) {
                    let cells = [];
                    let possible = true;
                    for (let i = 0; i < 5; i++) {
                        const nr = r + i * dr, nc = c + i * dc;
                        if (nr < 0 || nr >= 10 || nc < 0 || nc >= 10 || grid[nr][nc] !== color) {
                            possible = false;
                            break;
                        }
                        cells.push({ r: nr, c: nc });
                    }

                    if (possible) {
                        let usedCount = 0;
                        cells.forEach(cell => {
                            // Corners (FREE) don't count towards the shared chip limit
                            if (this.board[cell.r][cell.c] !== 'FREE' && usedInSequence[cell.r][cell.c]) {
                                usedCount++;
                            }
                        });

                        if (usedCount <= 1) { // Standard Sequence rule: max 1 shared non-corner chip
                            foundSequences.push(cells);
                            cells.forEach(cell => usedInSequence[cell.r][cell.c] = true);
                        }
                    }
                }
            }
        }

        return { count: foundSequences.length, sequences: foundSequences };
    }

    drawSequenceLine(cells, color) {
        // Always re-query to ensure we have the live element in the board
        const svg = document.getElementById('sequence-lines');
        if (!svg) return;

        const points = cells.map(pos => {
            const cell = document.getElementById(`cell-${pos.r}-${pos.c}`);
            if (!cell) return null;

            const boardRect = svg.getBoundingClientRect();
            const rect = cell.getBoundingClientRect();

            const x = rect.left - boardRect.left + (rect.width / 2);
            const y = rect.top - boardRect.top + (rect.height / 2);
            return `${x},${y}`;
        }).filter(p => p !== null).join(' ');

        if (!points) return;

        const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        polyline.setAttribute("points", points);
        polyline.setAttribute("class", `sequence-line ${color}`);
        svg.appendChild(polyline);
    }

    // ══════════════════════════════════════
    // AI LOGIC
    // ══════════════════════════════════════
    playAITurn() {
        if (this.aiTurnTimeout) {
            clearTimeout(this.aiTurnTimeout);
            this.aiTurnTimeout = null;
        }

        const colors = TEAM_COLORS.slice(0, this.teamCount);
        const myColor = this.currentTurn;
        const playerState = Object.values(this.playerStates).find(s => s.color === myColor);
        if (!playerState || !playerState.peerId || !playerState.peerId.startsWith('COMPUTER_')) return;

        const name = (this.colorNames && this.colorNames[myColor]) || 'Computer';
        this.log(`🤔 ${name} is thinking...`);

        const hand = playerState.hand;

        let bestMove = null;
        let bestScore = -Infinity;
        let deadCardIndex = -1;

        for (let i = 0; i < hand.length; i++) {
            const card = hand[i];
            const isOneEye = ONE_EYE.has(card);
            const isTwoEye = TWO_EYE.has(card);

            let possibleCells = [];

            if (isOneEye) {
                for (let r = 0; r < 10; r++) {
                    for (let c = 0; c < 10; c++) {
                        const chip = this.chips[r][c];
                        if (chip && chip !== myColor && !this.isChipInSequence(r, c, chip)) {
                            possibleCells.push({ r, c, type: 'remove' });
                        }
                    }
                }
            } else if (isTwoEye) {
                for (let r = 0; r < 10; r++) {
                    for (let c = 0; c < 10; c++) {
                        if (this.board[r][c] !== 'FREE' && this.chips[r][c] === null) {
                            possibleCells.push({ r, c, type: 'place' });
                        }
                    }
                }
            } else {
                let dead = true;
                for (let r = 0; r < 10; r++) {
                    for (let c = 0; c < 10; c++) {
                        if (this.board[r][c] === card && this.chips[r][c] === null) {
                            possibleCells.push({ r, c, type: 'place' });
                            dead = false;
                        }
                    }
                }
                if (dead) deadCardIndex = i;
            }

            for (const cell of possibleCells) {
                const score = this.evaluateMove(cell.r, cell.c, cell.type, myColor);
                const jitter = Math.random() * 0.1;
                const finalScore = score + jitter;

                if (finalScore > bestScore) {
                    bestScore = finalScore;
                    bestMove = { r: cell.r, c: cell.c, cardIndex: i, type: cell.type, cardName: card };
                }
            }
        }

        if (!bestMove) {
            if (deadCardIndex !== -1) {
                const newCard = this.deck.length > 0 ? this.deck.shift() : null;
                const deadCard = hand[deadCardIndex];
                hand.splice(deadCardIndex, 1);
                if (newCard) hand.push(newCard);

                const rank = deadCard.slice(0, -1);
                const suit = deadCard.slice(-1);
                this.log(`♻️ ${name} exchanged dead card: ${rank + SUITS[suit]}`);
                this.checkAndTriggerAITurn();
            } else {
                this.log(`⚠ ${name} has no valid moves!`);
                const nextIdx = (colors.indexOf(myColor) + 1) % colors.length;
                this.currentTurn = colors[nextIdx];
                this.updateTurnUI();
                this.checkAndTriggerAITurn();
            }
            return;
        }

        const { r, c, cardIndex, type, cardName } = bestMove;

        this.chips[r][c] = type === 'place' ? myColor : null;
        if (type === 'place') {
            this.lastMove = { r, c };
        } else {
            this.lastMove = null;
        }

        const drawnCard = this.deck.length > 0 ? this.deck.shift() : null;
        hand.splice(cardIndex, 1);
        if (drawnCard) hand.push(drawnCard);

        const rank = cardName.slice(0, -1);
        const suit = cardName.slice(-1);
        const displayName = rank + (SUITS[suit] || suit);

        this.log(`${type === 'place' ? '🤖✅' : '🤖❌'} Computer ${type === 'place' ? 'placed on' : 'removed from'} ${displayName}`);

        const nextIdx = (colors.indexOf(myColor) + 1) % colors.length;
        this.currentTurn = colors[nextIdx];
        this.renderBoard();
        this.updateTurnUI();
        this.checkSequences();

        this.checkAndTriggerAITurn();
    }

    evaluateMove(r, c, type, color) {
        const colors = TEAM_COLORS.slice(0, this.teamCount);
        const opponents = colors.filter(clr => clr !== color);
        const testChips = this.chips.map(row => [...row]);

        const countsBefore = this.getLineStats(testChips, color);

        // Sum of all opponents' stats
        let oppsBefore = { seqs: 0, max4: 0, max3: 0, max2: 0 };
        opponents.forEach(opp => {
            const stats = this.getLineStats(testChips, opp);
            oppsBefore.seqs += stats.seqs;
            oppsBefore.max4 += stats.max4;
            oppsBefore.max3 += stats.max3;
            oppsBefore.max2 += stats.max2;
        });

        testChips[r][c] = type === 'place' ? color : null;

        const countsAfter = this.getLineStats(testChips, color);

        let oppsAfter = { seqs: 0, max4: 0, max3: 0, max2: 0 };
        opponents.forEach(opp => {
            const stats = this.getLineStats(testChips, opp);
            oppsAfter.seqs += stats.seqs;
            oppsAfter.max4 += stats.max4;
            oppsAfter.max3 += stats.max3;
            oppsAfter.max2 += stats.max2;
        });

        let score = 0;

        if (type === 'place') {
            if (countsAfter.seqs > countsBefore.seqs) score += 10000;
            else {
                // Check if this move blocks any opponent from finishing a sequence
                let blockedAnySeq = false;
                opponents.forEach(opp => {
                    testChips[r][c] = opp;
                    const oppIfPlayed = this.getLineStats(testChips, opp);
                    const statsBefore = this.getLineStats(this.chips, opp);
                    if (oppIfPlayed.seqs > statsBefore.seqs) blockedAnySeq = true;
                });

                if (blockedAnySeq) {
                    score += 8000;
                } else {
                    // Score based on blocking opponent's progress and making our own
                    score += (oppsBefore.max4 - oppsAfter.max4) * 800; // Blocking opponent 4-in-a-row
                    score += (oppsBefore.max3 - oppsAfter.max3) * 50;

                    score += (countsAfter.max4 - countsBefore.max4) * 100;
                    score += (countsAfter.max3 - countsBefore.max3) * 10;
                    score += (countsAfter.max2 - countsBefore.max2) * 1;
                }
            }
        } else if (type === 'remove') {
            score += (oppsBefore.max4 - oppsAfter.max4) * 800;
            score += (oppsBefore.max3 - oppsAfter.max3) * 150;
            score += (oppsBefore.max2 - oppsAfter.max2) * 20;
        }

        const centerDist = Math.abs(r - 4.5) + Math.abs(c - 4.5);
        score -= centerDist * 0.1;

        return score;
    }

    getLineStats(chipsArray, color) {
        const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
        const grid = chipsArray.map((row, r) =>
            row.map((cell, c) => this.board[r][c] === 'FREE' ? color : cell)
        );
        let seqs = 0, max4 = 0, max3 = 0, max2 = 0;

        for (let r = 0; r < 10; r++) {
            for (let c = 0; c < 10; c++) {
                for (const [dr, dc] of directions) {
                    let run = 0, gaps = 0;
                    for (let i = 0; i < 5; i++) {
                        const nr = r + i * dr, nc = c + i * dc;
                        if (nr >= 0 && nr < 10 && nc >= 0 && nc < 10) {
                            if (grid[nr][nc] === color) run++;
                            else if (grid[nr][nc] !== null && this.board[nr][nc] !== 'FREE') gaps = 10;
                        } else {
                            gaps = 10;
                        }
                    }
                    if (gaps < 10) {
                        if (run === 5) seqs++;
                        else if (run === 4) max4++;
                        else if (run === 3) max3++;
                        else if (run === 2) max2++;
                    }
                }
            }
        }
        return { seqs, max4, max3, max2 };
    }

    isChipInSequence(r, c, color) {
        return this.sequenceGrid[r][c] === true;
    }

    // ══════════════════════════════════════
    // UI HELPERS
    // ══════════════════════════════════════
    updateTurnUI() {
        const ui = this.ui;
        if (!ui.turnIndicator || !this.currentTurn) return;
        const mine = this.currentTurn === this.myColor;
        if (mine) {
            if (ui.turnIndicator.innerText !== "Your Turn!") {
                this.exchangedThisTurn = false; // Reset on turn start
            }
            ui.turnIndicator.innerText = "Your Turn!";
            this.showTurnOverlay();
            if (navigator.vibrate) navigator.vibrate(200);
        } else {
            const name = (this.colorNames && this.colorNames[this.currentTurn]) || this.currentTurn;
            ui.turnIndicator.innerText = `⏳ ${name}'s turn…`;
        }
        ui.turnIndicator.style.color = mine ? "var(--gold)" : "var(--text)";
        this.updateJackHint();
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
        if (ui.gameOverOverlay && ui.winnerDisplay) {
            const teamColor = winner.toLowerCase();
            const colorHex = teamColor === 'red' ? '#ff7675' : (teamColor === 'blue' ? '#74b9ff' : '#55efc4');

            ui.winnerDisplay.innerText = `${winner.toUpperCase()} TEAM WINS!`;
            ui.winnerDisplay.style.color = colorHex;
            ui.winnerDisplay.style.textShadow = `0 0 30px ${colorHex}99, 0 4px 20px rgba(0,0,0,0.5)`;

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

        overlay.style.display = 'flex';

        // Vibrate if mobile
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

        clearTimeout(this._seqPopupTimer);
        this._seqPopupTimer = setTimeout(() => {
            overlay.style.display = 'none';
        }, 2000);
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
