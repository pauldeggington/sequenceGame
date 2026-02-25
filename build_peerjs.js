const fs = require('fs');
let code = fs.readFileSync('game.js', 'utf8');

const lines = code.split('\n');

// We need to replace three chunks:
// Chunk 1: 'nameInput.addEventListener' to 'getName(' callback
// Chunk 2: 'const shareUrl = ...' to 'renderSetupState' function
// Chunk 3: 'this.room.onPeerJoin' to end of 'initSetup'

// Let's find index markers
const m1_start = lines.findIndex(l => l.includes("nameInput.addEventListener('input', () => {"));
const m1_end = lines.findIndex(l => l.includes("getName((name, peerId) => {"));
const m1_end_actual = m1_end + 3; // +3 to consume the getName block

const m2_start = lines.findIndex(l => l.includes("const shareUrl = `${window.location.origin}${window.location.pathname}#${roomId}`;"));
const m2_end = lines.findIndex(l => l.includes("        };")) // end of renderSetupState
const m2_start_actual = m2_start - 1 // remove the comment before shareUrl

const m3_start = lines.findIndex(l => l.includes("        // ── Peer events ──"));
const m3_end = lines.findIndex(l => l.includes("    }")) // end of initSetup()

// NEW CHUNK 1
const new_chunk_1 = `        const renderSetupState = () => {
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

        // Determine room ID
        let roomId = window.location.hash.substring(1);
        const savedRoomId = localStorage.getItem('sequence_roomID');
        const savedIsHost = localStorage.getItem('sequence_isHost');

        if (roomId) {
            this.isHost = false;
            statusEl.innerText = "Joining room...";
            localStorage.setItem('sequence_roomID', roomId);
            localStorage.setItem('sequence_isHost', 'false');
        } else if (savedRoomId && savedIsHost === 'true') {
            roomId = savedRoomId;
            window.location.hash = roomId;
            this.isHost = true;
            statusEl.innerText = "Re-hosting room...";
        } else {
            roomId = genId(8);
            window.location.hash = roomId;
            this.isHost = true;
            statusEl.innerText = "Room created!";
            localStorage.setItem('sequence_roomID', roomId);
            localStorage.setItem('sequence_isHost', 'true');
        }

        const shareUrl = \`\${window.location.origin}\${window.location.pathname}#\${roomId}\`;

        this.peer = new Peer(this.isHost ? roomId : undefined);

        this.peer.on('open', (id) => {
            if (this.isHost) {
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
                if (this.isHost) this.broadcast('name', data, peerId);
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
            }
        };`;


// NEW CHUNK 3
const new_chunk_3 = `        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === 'visible') {
                if (!this.isHost && (!this.hostConnection || !this.hostConnection.open)) {
                    document.getElementById('setup-status').innerText = "Resuming session...";
                    this.attemptReconnect();
                }
            }
        });
    }

    connectToHost(hostID) {
        const newConn = this.peer.connect(hostID, { reliable: true });
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
        
        conn.on('open', () => {
            if (this.isHost) {
                if (!this.peers.includes(conn.peer)) {
                    this.peers.push(conn.peer);
                }
                this.connections[conn.peer] = conn;
                
                statusEl.innerText = \`\${this.peers.length + 1} players connected\`;
                playerList.style.display = 'block';
                startBtn.style.display = 'block';
                
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
                            colorNames: this.colorNames,
                            hintsEnabled: this.hintsEnabled,
                            boardChips: this.chips,
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
                this.handleData('name', leaverName + ' (Disconnected)', conn.peer);
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


// Apply replacements from bottom up to avoid shifting indices

lines.splice(m3_start, m3_end - m3_start + 1, new_chunk_3);

lines.splice(m2_start_actual, m2_end - m2_start_actual + 1, "");

lines.splice(m1_start, m1_end_actual - m1_start + 1, new_chunk_1);

fs.writeFileSync('game.js', lines.join('\\n'));
