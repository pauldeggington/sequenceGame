const fs = require('fs');
let code = fs.readFileSync('game.js', 'utf8');

// Replace imports
code = code.replace(
    "import { joinRoom, selfId } from 'https://esm.run/trystero';",
    "// Networking now uses PeerJS loaded via <script> tag in index.html"
);

// Replace initSetup and constructor variables
// I'll define start and end lines to slice and replace.
const lines = code.split('\n');
const startConstructorVars = lines.findIndex(l => l.includes('this.room = null;'));
const endConstructorVars = lines.findIndex(l => l.includes('this.sendSync = null;'));

lines.splice(startConstructorVars, endConstructorVars - startConstructorVars + 1,
    `        this.peer = null;
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
        this.hands = {};         // For reconnects, host saves all hands dealt`);

// Find initSetup to startGame
const initSetupIdx = lines.findIndex(l => l.includes('initSetup() {'));
const updateTeamLabelsIdx = lines.findIndex(l => l.includes('updateTeamLabels(container) {'));

const newInitSetup = `
    initSetup() {
        const statusEl = document.getElementById('setup-status');
        const inviteBox = document.getElementById('invite-box');
        const inviteUrl = document.getElementById('invite-url');
        const teamCfg = document.getElementById('team-config');
        const playerList = document.getElementById('player-list');
        const playersEl = document.getElementById('players-connected');
        const startBtn = document.getElementById('start-game-btn');
        const waitMsg = document.getElementById('waiting-msg');
        const teamLabels = document.getElementById('team-labels');
        const nameInput = document.getElementById('player-name');

        const renderSetupState = () => {
            playersEl.innerHTML = '';
            const myDisplay = this.myName || 'You';
            const me = document.createElement('div');
            me.className = 'player-entry me';
            me.innerText = \`👤 \${myDisplay}\${this.isHost ? ' (Host)' : ''}\`;
            playersEl.appendChild(me);

            this.peers.forEach((pid, i) => {
                const el = document.createElement('div');
                el.className = 'player-entry';
                const peerName = this.peerNames[pid] || \`Player \${i + 2}\`;
                el.innerText = \`👤 \${peerName}\`;
                playersEl.appendChild(el);
            });
        };

        // Name input
        nameInput.addEventListener('input', () => {
            this.myName = nameInput.value.trim();
            this.broadcast('name', this.myName);
            renderSetupState();
        });

        // Determine room ID and Host status
        let roomId = window.location.hash.substring(1);
        
        // Check localStorage for resuming
        const savedRoomId = localStorage.getItem('sequence_roomID');
        const savedIsHost = localStorage.getItem('sequence_isHost');

        if (roomId) {
            // Joining via link
            this.isHost = false;
            statusEl.innerText = "Joining room...";
            localStorage.setItem('sequence_roomID', roomId);
            localStorage.setItem('sequence_isHost', 'false');
        } else if (savedRoomId && savedIsHost === 'true') {
            // Resuming as Host
            roomId = savedRoomId;
            window.location.hash = roomId;
            this.isHost = true;
            statusEl.innerText = "Re-hosting room...";
        } else {
            // New Host
            roomId = genId(8);
            window.location.hash = roomId;
            this.isHost = true;
            statusEl.innerText = "Room created!";
            localStorage.setItem('sequence_roomID', roomId);
            localStorage.setItem('sequence_isHost', 'true');
        }

        const shareUrl = \`\${window.location.origin}\${window.location.pathname}#\${roomId}\`;

        // Initialize PeerJS (ensure Peer is available globally from script tag)
        // Initialize PeerJS with explicit public STUN servers for Safari/iOS WebRTC compatibility
        const peerConfig = {
            config: {
                'iceServers': [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun2.l.google.com:19302' },
                    { urls: 'stun:stun3.l.google.com:19302' },
                    { urls: 'stun:stun4.l.google.com:19302' }
                ]
            }
        };
        this.peer = new Peer(this.isHost ? roomId : undefined, peerConfig);

        this.peer.on('open', (id) => {
            if (this.isHost) {
                // Wait for connections
                statusEl.innerText = "Waiting for players...";
                
                inviteBox.style.display = 'block';
                inviteUrl.value = shareUrl;
                inviteUrl.addEventListener('click', () => {
                    inviteUrl.select();
                    navigator.clipboard.writeText(shareUrl).then(() => {
                        const originalLabel = document.querySelector('.invite-label').innerText;
                        document.querySelector('.invite-label').innerText = '📋 Copied to clipboard!';
                        document.querySelector('.invite-label').style.color = 'var(--gold)';
                        setTimeout(() => {
                            document.querySelector('.invite-label').innerText = originalLabel;
                            document.querySelector('.invite-label').style.color = '';
                        }, 2000);
                    });
                });
                teamCfg.style.display = 'block';
                this.updateTeamLabels(teamLabels);
                renderSetupState();
                
            } else {
                console.log("Attempting to join session:", roomId);
                this.connectToHost(roomId);
            }
        });

        // Handle incoming connections (Host only)
        if (this.isHost) {
            this.peer.on('connection', (conn) => {
                this.setupConnection(conn);
            });
        }

        // ── Actions Setup ──
        this.sendName = (name) => this.broadcast('name', name);
        this.sendConfig = (config) => this.broadcast('config', config);
        this.sendGameStart = (data, pId) => pId ? this.sendTo(pId, 'gameStart', data) : this.broadcast('gameStart', data);
        this.sendMove = (data) => this.broadcast('move', data);
        this.sendSync = (data) => this.broadcast('sync', data);

        // ── Data Handlers ──
        this.handleData = (type, data, peerId) => {
            if (type === 'name') {
                this.peerNames[peerId] = data;
                renderSetupState();
                // If Host receives a name, broadcast to other clients
                if (this.isHost) {
                    this.broadcast('name', data, peerId);
                }
            } else if (type === 'config' && !this.isHost) {
                if (data.teamCount) {
                    this.teamCount = data.teamCount;
                    document.querySelectorAll('.team-btn').forEach(btn => {
                        btn.classList.toggle('selected', parseInt(btn.dataset.teams) === this.teamCount);
                    });
                    this.updateTeamLabels(teamLabels);
                }
                if (data.hintsEnabled !== undefined) {
                    this.hintsEnabled = data.hintsEnabled;
                    const toggle = document.getElementById('show-hints-toggle');
                    if (toggle) toggle.checked = this.hintsEnabled;
                }
                teamCfg.style.display = 'block';
                playerList.style.display = 'block';
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
                this.colorNames = data.colorNames || {};
                this.hintsEnabled = data.hintsEnabled || false;
                this.started = true;
                this.showGameScreen();
                
                // Also restore board state if it's a mid-game reconnect sync
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
                // Host relays moves to clients
                if (this.isHost) {
                    this.broadcast('move', data, peerId);
                }
            } else if (type === 'sync') {
                this.sequences = data.sequences;
                this.updateScoreUI();
                this.renderBoard();
                if (data.winner) {
                    this.currentTurn = null;
                    this.showWinPopup(data.winner);
                }
            }
        };

        // ── Setup UI Events ──
        document.querySelectorAll('.team-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!this.isHost) return;
                document.querySelectorAll('.team-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                this.teamCount = parseInt(btn.dataset.teams);
                this.updateTeamLabels(teamLabels);
                this.sendConfig({ teamCount: this.teamCount });
            });
        });

        startBtn.addEventListener('click', () => {
            this.startGame();
        });

        const hintToggle = document.getElementById('show-hints-toggle');
        hintToggle.addEventListener('change', () => {
            this.hintsEnabled = hintToggle.checked;
            if (this.isHost) {
                this.sendConfig({ hintsEnabled: this.hintsEnabled });
            }
        });

        const playAgainBtn = document.getElementById('play-again-btn');
        const playAgainWait = document.getElementById('play-again-waiting');
        if (playAgainBtn) {
            playAgainBtn.addEventListener('click', () => {
                if (this.isHost) {
                    this.startGame();
                } else {
                    playAgainWait.style.display = 'block';
                    playAgainBtn.style.display = 'none';
                }
            });
        }
        
        // 4. Handle Mobile Tab Sleep/Wake
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === 'visible') {
                // Check if connection is dead
                if (!this.isHost && (!this.hostConnection || !this.hostConnection.open)) {
                    statusEl.innerText = "Resuming session...";
                    this.attemptReconnect();
                }
            }
        });
    }

    connectToHost(hostID) {
        const newConn = this.peer.connect(hostID, {
            reliable: true // Ensures data isn't lost during brief hiccups
        });
        this.hostConnection = newConn;
        this.setupConnection(newConn);
    }

    attemptReconnect() {
        const roomID = window.location.hash.substring(1);
        if (roomID && (!this.hostConnection || !this.hostConnection.open)) {
            setTimeout(() => {
                console.log("Retrying connection...");
                this.connectToHost(roomID);
            }, 3000); 
        }
    }

    setupConnection(conn) {
        const statusEl = document.getElementById('setup-status');
        const waitMsg = document.getElementById('waiting-msg');
        const playerList = document.getElementById('player-list');
        const startBtn = document.getElementById('start-game-btn');
        
        // Wait for connection to open
        conn.on('open', () => {
            if (this.isHost) {
                if (!this.peers.includes(conn.peer)) {
                    this.peers.push(conn.peer);
                }
                this.connections[conn.peer] = conn;
                
                statusEl.innerText = \`\${this.peers.length + 1} players connected\`;
                playerList.style.display = 'block';
                startBtn.style.display = 'block';
                
                // Send current config to the new peer
                this.sendTo(conn.peer, 'config', { teamCount: this.teamCount, hintsEnabled: this.hintsEnabled });
                if (this.myName) {
                    this.sendTo(conn.peer, 'name', this.myName);
                }
                
                // If the game already started, send them the current state so they can reconnect!
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
                            colorNames: this.colorNames,
                            hintsEnabled: this.hintsEnabled,
                            boardChips: this.chips, // Custom field for reconnect
                            sequences: this.sequences
                        });
                    }
                }
                
                this.handleData('name', this.peerNames[conn.peer] || 'Player ' + (this.peers.length + 1), conn.peer);
            } else {
                statusEl.innerText = "Connected! Waiting for host to start...";
                waitMsg.style.display = 'block';
                playerList.style.display = 'block';
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
                this.handleData('name', leaverName + ' (Disconnected)', conn.peer); // force rerender setup
                if (this.started) {
                    this.log(\`❌ \${leaverName} disconnected.\`);
                }
            } else {
                statusEl.innerText = "Connection lost. Attempting reconnect...";
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

`;

lines.splice(initSetupIdx, updateTeamLabelsIdx - initSetupIdx, newInitSetup);

let finalCode = lines.join('\n');

// Update startGame variable hands storage
finalCode = finalCode.replace(
    `        // Host setup
        this.hand = hands['host'];`,
    `        this.hands = hands;
        // Host setup
        this.hand = hands['host'];`
);

fs.writeFileSync('game.js', finalCode);
