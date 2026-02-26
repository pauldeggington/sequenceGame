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
    ["6S", "5S", "4S", "3S", "2S", "4H", "5H", "6H", "7H", "AS"],
    ["7S", "AS", "2D", "3D", "4D", "KH", "QH", "10H", "8H", "KS"],
    ["8S", "KC", "6C", "5C", "4C", "9H", "8H", "9S", "9H", "QS"],
    ["9S", "QC", "7C", "6H", "5H", "2H", "7H", "8S", "10H", "10S"],
    ["AS", "7H", "9H", "AH", "4H", "3H", "KH", "10D", "6D", "2D"],
    ["KS", "8H", "8D", "2C", "3C", "10D", "QD", "QC", "5D", "3D"],
    ["QS", "9H", "7D", "6D", "5D", "AC", "AD", "KC", "4D", "4D"],
    ["10S", "10C", "QC", "KC", "AC", "3C", "2C", "2H", "3H", "5D"],
    ["FREE", "9C", "8C", "7C", "6C", "9D", "8D", "7D", "6D", "FREE"]
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
        this.started = false;
        this.hintsEnabled = false;
        this.hoveredCardIndex = null;
        this.hands = {};         // Host saves all hands dealt for reconnects

        this.initSetup();
    }

    // ══════════════════════════════════════
    // SETUP SCREEN
    // ══════════════════════════════════════
    initSetup() {
        this.setupUI = {
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
        };

        const renderSetupState = () => {
            if (!this.setupUI.playersEl) return;
            this.setupUI.playersEl.innerHTML = '';
            const myDisplay = this.myName || 'You';
            const me = document.createElement('div');
            me.className = 'player-entry me';
            me.innerText = `👤 ${myDisplay}${this.isHost ? ' (Host)' : ''}`;
            this.setupUI.playersEl.appendChild(me);

            this.peers.forEach((pid, i) => {
                const el = document.createElement('div');
                el.className = 'player-entry';
                let peerName = this.peerNames[pid];
                if (!peerName) {
                    if (pid === 'HOST') peerName = 'Host';
                    else peerName = `Player ${i + 2}`;
                }
                el.innerText = `👤 ${peerName}`;
                this.setupUI.playersEl.appendChild(el);
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
        if (this.setupUI.nameInput) {
            this.setupUI.nameInput.addEventListener('input', () => {
                this.myName = this.setupUI.nameInput.value.trim();
                if (this.isHost) {
                    this.syncPlayers();
                } else if (this.sendName) {
                    this.sendName(this.myName);
                }
                renderSetupState();
            });
        }

        // ── Actions Setup ──
        this.sendName = (name) => this.broadcast('name', name);
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
            this.setupUI.status.innerText = "Re-hosting room...";
            this.startSession(hashId, true);
        } else if (hashId) {
            this.setupUI.status.innerText = "Joining room...";
            this.startSession(hashId, false);
        } else if (savedRoomId && savedIsHost === 'true') {
            this.setupUI.createSec.style.display = 'block';
            this.setupUI.status.innerText = "Ready to start a game";
        } else {
            this.setupUI.createSec.style.display = 'block';
            this.setupUI.status.innerText = "Welcome to Very Wild Jacks";
        }

        this.setupUI.createBtn.addEventListener('click', () => {
            const newId = genId(8);
            this.setupUI.status.innerText = "Creating room...";
            this.startSession(newId, true);
        });

        this.initEventListeners();
    }

    initEventListeners() {
        const ui = this.setupUI;
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
        const hintToggle = document.getElementById('show-hints-toggle');
        if (hintToggle) {
            hintToggle.onchange = () => {
                this.hintsEnabled = hintToggle.checked;
                if (this.isHost) {
                    this.sendConfig({ hintsEnabled: this.hintsEnabled });
                }
            };
        }

        // Play Again
        const playAgainBtn = document.getElementById('play-again-btn');
        if (playAgainBtn) {
            playAgainBtn.onclick = () => {
                if (this.isHost) {
                    this.startGame();
                } else {
                    document.getElementById('play-again-waiting').style.display = 'block';
                    playAgainBtn.style.display = 'none';
                }
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
        const ui = this.setupUI;
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
        const ui = this.setupUI;
        if (type === 'name') {
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
            this.applyOpponentMove(data);
            this.currentTurn = data.nextTurn;
            this.updateTurnUI();
            if (this.isHost) this.broadcast('move', data, peerId);
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

        const ui = this.setupUI;
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
        const ui = this.setupUI;

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
                    this.sendName(this.myName);
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

        // Assign colors round-robin
        const assignments = [];
        assignments.push({ peerId: null, color: colors[0] });
        this.peers.forEach((pid, i) => {
            assignments.push({ peerId: pid, color: colors[(i + 1) % colors.length] });
        });

        // Build color → name map
        this.colorNames = {};
        assignments.forEach(a => {
            if (a.peerId) {
                this.colorNames[a.color] = this.peerNames[a.peerId] || a.color;
            } else {
                this.colorNames[a.color] = this.myName || 'You';
            }
        });

        // Deal hands
        const hands = {};
        assignments.forEach(a => {
            const key = a.peerId || 'host';
            hands[key] = this.deck.splice(0, cardsPerPlayer);
        });

        // Host setup
        this.hand = hands['host'];
        this.myColor = colors[0];
        this.currentTurn = colors[0];
        this.started = true;

        // Send to each peer
        assignments.forEach(a => {
            if (a.peerId) {
                this.sendGameStart({
                    deck: [...this.deck],
                    myHand: hands[a.peerId],
                    myColor: a.color,
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
        document.getElementById('game-over-overlay').style.display = 'none';
        document.getElementById('play-again-waiting').style.display = 'none';
        document.getElementById('play-again-btn').style.display = 'inline-block';
        this.chips = Array(10).fill(null).map(() => Array(10).fill(null));
        this.sequences = { red: 0, blue: 0, green: 0 };

        this.showGameScreen();
    }

    showGameScreen() {
        document.getElementById('setup-screen').style.display = 'none';
        document.getElementById('game-screen').style.display = 'block';

        // Show green score if 3 teams
        if (this.teamCount >= 3) {
            document.getElementById('green-score-wrap').style.display = 'inline';
        }

        const teamEmojis = { red: '🔴 Red', blue: '🔵 Blue', green: '🟢 Green' };
        const myTeamEl = document.getElementById('my-team-name');
        if (myTeamEl && this.myColor && teamEmojis[this.myColor]) {
            myTeamEl.innerHTML = `<span class="team-tag ${this.myColor}" style="padding: 2px 8px;">${teamEmojis[this.myColor]}</span>`;
        }

        this.initGameElements();
        this.renderBoard();
        this.renderHand(true); // Animate first deal
        this.updateTurnUI();
        this.updateScoreUI();

        const myName = this.myName || 'Player 1';
        this.log(`🎨 ${myName} are on team ${this.myColor.toUpperCase()}`);
        this.log("🃏 Cards dealt! " + this.currentTurn + " goes first.");
    }

    initGameElements() {
        this.boardEl = document.getElementById('game-board');
        this.handEl = document.getElementById('player-hand');
        this.turnIndicator = document.getElementById('turn-indicator');
        this.logEl = document.getElementById('log-content');
        this.jackHint = document.getElementById('jack-hint');

        // Emoji UI initialization
        const emojiTrigger = document.getElementById('emoji-trigger');
        const emojiMenu = document.getElementById('emoji-menu');
        if (emojiTrigger && emojiMenu) {
            emojiTrigger.onclick = (e) => {
                e.stopPropagation();
                emojiMenu.style.display = emojiMenu.style.display === 'none' ? 'block' : 'none';
            };
            document.querySelectorAll('.emoji-opt').forEach(opt => {
                opt.onclick = (e) => {
                    e.stopPropagation();
                    const emoji = opt.innerText;
                    this.sendEmoji(emoji);
                    this.showEmojiFloat(emoji);
                };
            });
            document.addEventListener('click', () => emojiMenu.style.display = 'none');
            emojiMenu.onclick = (e) => e.stopPropagation();
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
        if (!this.boardEl) return;

        // If we already have the cells, just update highlights unless forced
        if (!forceFullRedraw && this.boardEl.children.length === 100) {
            this.updateHighlightsOnly();
            return;
        }

        this.boardEl.innerHTML = '';
        for (let r = 0; r < 10; r++) {
            for (let c = 0; c < 10; c++) {
                const val = this.board[r][c];
                const cell = document.createElement('div');
                const chip = this.chips[r][c];

                let highlight = '';
                if (this.jackMode === 'one-eye' && chip && chip !== this.myColor) highlight = ' highlight-remove';
                if (this.jackMode === 'two-eye' && !chip && val !== 'FREE') highlight = ' highlight-place';

                // Hint highlighting (Selected OR Hovered)
                if (this.hintsEnabled && !this.jackMode && this.currentTurn === this.myColor) {
                    const selectedCard = this.selectedCardIndex !== null ? this.hand[this.selectedCardIndex] : null;
                    const hoveredCard = this.hoveredCardIndex !== null ? this.hand[this.hoveredCardIndex] : null;

                    if ((val === selectedCard || val === hoveredCard) && !chip) {
                        highlight = ' highlight-hint';
                    }
                }

                cell.className = `cell${val === 'FREE' ? ' free' : ''}${highlight}`;

                if (val === 'FREE') {
                    const freeEl = document.createElement('div');
                    freeEl.className = 'cell-card-simple free-space';
                    freeEl.innerText = '★';
                    cell.appendChild(freeEl);
                } else {
                    const rank = val.slice(0, -1);
                    const suit = val.slice(-1);

                    const simpleCard = document.createElement('div');
                    simpleCard.className = `cell-card-simple ${suit === 'H' || suit === 'D' ? 'red-suit' : 'black-suit'}`;

                    const rankEl = document.createElement('div');
                    rankEl.className = 'simple-rank';
                    rankEl.innerText = rank;

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
                this.boardEl.appendChild(cell);
            }
        }
    }

    updateHighlightsOnly() {
        const selectedCard = this.selectedCardIndex !== null ? this.hand[this.selectedCardIndex] : null;
        const hoveredCard = this.hoveredCardIndex !== null ? this.hand[this.hoveredCardIndex] : null;

        for (let r = 0; r < 10; r++) {
            for (let c = 0; c < 10; c++) {
                const cell = this.boardEl.children[r * 10 + c];
                const val = this.board[r][c];
                const chip = this.chips[r][c];

                let highlight = '';
                if (this.jackMode === 'one-eye' && chip && chip !== this.myColor) highlight = ' highlight-remove';
                if (this.jackMode === 'two-eye' && !chip && val !== 'FREE') highlight = ' highlight-place';

                if (this.hintsEnabled && !this.jackMode && this.currentTurn === this.myColor) {
                    if ((val === selectedCard || val === hoveredCard) && !chip) {
                        highlight = ' highlight-hint';
                    }
                }

                const baseClass = val === 'FREE' ? 'cell free' : 'cell';
                if (cell.className !== baseClass + highlight) {
                    cell.className = baseClass + highlight;
                }
            }
        }
    }

    renderHand(animate = false) {
        if (!this.handEl) return;
        this.handEl.innerHTML = '';
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
                if (this.currentTurn !== this.myColor || !this.hintsEnabled) return;
                this.hoveredCardIndex = index;
                this.updateHighlightsOnly();
            };

            cardEl.onpointerleave = () => {
                if (this.hoveredCardIndex === index) {
                    this.hoveredCardIndex = null;
                    this.updateHighlightsOnly();
                }
            };

            this.handEl.appendChild(cardEl);
        });
    }


    updateJackHint() {
        if (!this.jackHint) return;
        if (this.jackMode === 'one-eye') {
            this.jackHint.innerText = "👁 One-Eyed Jack: Click an opponent's chip to remove it.";
            this.jackHint.style.display = 'block';
        } else if (this.jackMode === 'two-eye') {
            this.jackHint.innerText = "👁👁 Two-Eyed Jack: Click any empty cell to place your chip.";
            this.jackHint.style.display = 'block';
        } else {
            this.jackHint.style.display = 'none';
        }
    }

    updateScoreUI() {
        document.getElementById('red-score').innerText = this.sequences.red;
        document.getElementById('blue-score').innerText = this.sequences.blue;
        if (this.teamCount >= 3) {
            document.getElementById('green-score').innerText = this.sequences.green;
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
            cardName
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

    applyOpponentMove(data) {
        const { row, col, color, moveType, drew, cardName, nextTurn } = data;

        if (moveType === 'exchange') {
            if (drew && this.deck.length > 0) this.deck.shift();
            const name = (this.colorNames && this.colorNames[color]) || color;
            this.log(`♻️ ${name} exchanged dead card: ${cardName}`);
            return; // Turn continues for them
        }

        this.chips[row][col] = moveType === 'place' ? color : null;
        if (drew && this.deck.length > 0) this.deck.shift();

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
        }
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
        if (!this.turnIndicator || !this.currentTurn) return;
        const mine = this.currentTurn === this.myColor;
        if (mine) {
            this.turnIndicator.innerText = "Your Turn!";
            this.showTurnOverlay();
            if (navigator.vibrate) {
                navigator.vibrate(200);
            }
        } else {
            const name = (this.colorNames && this.colorNames[this.currentTurn]) || this.currentTurn;
            this.turnIndicator.innerText = `⏳ ${name}'s turn…`;
        }
        this.turnIndicator.style.color = mine ? "var(--gold)" : "var(--text)";
    }

    showTurnOverlay() {
        const overlay = document.getElementById('turn-overlay');
        if (!overlay) return;
        overlay.style.display = 'flex';
        clearTimeout(this._overlayTimer);
        this._overlayTimer = setTimeout(() => {
            overlay.style.display = 'none';
        }, 1200);
    }

    showWinPopup(winner) {
        const overlay = document.getElementById('game-over-overlay');
        const text = document.getElementById('winner-text');
        if (overlay && text) {
            text.innerText = `${winner.toUpperCase()} TEAM WINS!`;
            text.style.color = winner === 'red' ? '#ff7675' : (winner === 'blue' ? '#74b9ff' : '#55efc4');
            overlay.style.display = 'flex';
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
        const container = document.getElementById('emoji-float-container');
        if (!container) return;

        const el = document.createElement('div');
        el.className = 'floating-emoji';
        el.innerText = emoji;

        // Random horizontal position
        const left = 20 + Math.random() * 60; // 20% to 80%
        el.style.left = left + '%';
        el.style.bottom = '20px';

        container.appendChild(el);
        setTimeout(() => el.remove(), 3000);
    }

    log(msg) {
        if (!this.logEl) return;
        const el = document.createElement('div');
        el.className = 'log-entry';
        el.innerText = msg;
        this.logEl.appendChild(el);

        // Auto-scroll to the new entry
        const container = document.getElementById('game-log');
        if (container) {
            container.scrollTo({
                top: container.scrollHeight,
                behavior: 'smooth'
            });
        }
    }
}

// ── Boot ──
new SequenceGame();
