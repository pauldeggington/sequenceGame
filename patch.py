import os

with open('game.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

new_lines = []
in_init_setup = False
skip_to = None

for i, line in enumerate(lines):
    # Skip lines if we are replacing a block
    if skip_to is not None:
        if i < skip_to:
            continue
        else:
            skip_to = None

    if "import { joinRoom, selfId } from 'https://esm.run/trystero';" in line:
        new_lines.append("// Networking now uses PeerJS loaded via <script> tag in index.html\n")
        continue

    if "this.room = null;" in line:
        new_lines.extend([
            "        this.peer = null;\n",
            "        this.connections = {};\n",
            "        this.hostConnection = null;\n",
            "        this.isHost = false;\n",
            "        this.myColor = null;\n",
            "        this.currentTurn = null;\n",
            "        this.selectedCardIndex = null;\n",
            "        this.sequences = { red: 0, blue: 0, green: 0 };\n",
            "        this.jackMode = null;\n",
            "        this.teamCount = 2;\n",
            "        this.peers = [];         // connected peer IDs\n",
            "        this.peerNames = {};     // peerId -> name\n",
            "        this.myName = '';\n",
            "        this.started = false;\n",
            "        this.hintsEnabled = false;\n",
            "        this.hoveredCardIndex = null;\n",
            "        this.hands = {};         // For reconnects, host saves all hands dealt\n"
        ])
        # Skip until initSetup
        skip_to = i + 15
        continue

    if "    initSetup() {" in line:
        new_lines.append(line)
        in_init_setup = True
        continue

    if in_init_setup and "        // Name input" in line:
        import textwrap
        setup_logic = textwrap.dedent("""\
        const renderSetupState = () => {
            playersEl.innerHTML = '';
            const myDisplay = this.myName || 'You';
            const me = document.createElement('div');
            me.className = 'player-entry me';
            me.innerText = `👤 ${myDisplay}${this.isHost ? ' (Host)' : ''}`;
            playersEl.appendChild(me);

            this.peers.forEach((pid, i) => {
                const el = document.createElement('div');
                el.className = 'player-entry';
                const peerName = this.peerNames[pid] || `Player ${i + 2}`;
                el.innerText = `👤 ${peerName}`;
                playersEl.appendChild(el);
            });
        };

        // Name input
        ui.nameInput.addEventListener('input', () => {
            this.myName = ui.nameInput.value.trim();
            this.broadcast('name', this.myName);
            renderSetupState();
        });

        let roomId = window.location.hash.substring(1);
        const savedRoomId = localStorage.getItem('sequence_roomID');
        const savedIsHost = localStorage.getItem('sequence_isHost');

        if (roomId) {
            this.isHost = false;
            ui.status.innerText = "Joining room...";
            localStorage.setItem('sequence_roomID', roomId);
            localStorage.setItem('sequence_isHost', 'false');
        } else if (savedRoomId && savedIsHost === 'true') {
            roomId = savedRoomId;
            window.location.hash = roomId;
            this.isHost = true;
            ui.status.innerText = "Re-hosting room...";
        } else {
            roomId = genId(8);
            window.location.hash = roomId;
            this.isHost = true;
            ui.status.innerText = "Room created!";
            localStorage.setItem('sequence_roomID', roomId);
            localStorage.setItem('sequence_isHost', 'true');
        }

        const shareUrl = `${window.location.origin}${window.location.pathname}#${roomId}`;

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
        this.peer = this.isHost ? new Peer(roomId, peerConfig) : new Peer(peerConfig);

        this.peer.on('open', (id) => {
            if (this.isHost) {
                ui.status.innerText = "Waiting for players...";
                ui.inviteBox.style.display = 'block';
                ui.inviteUrl.value = shareUrl;
                ui.inviteUrl.addEventListener('click', () => {
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
                });
                ui.teamCfg.style.display = 'block';
                this.updateTeamLabels(ui.teamLabels);
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

        this.sendName = (name) => this.broadcast('name', name);
        this.sendConfig = (config) => this.broadcast('config', config);
        this.sendGameStart = (data, pId) => pId ? this.sendTo(pId, 'gameStart', data) : this.broadcast('gameStart', data);
        this.sendMove = (data) => this.broadcast('move', data);
        this.sendSync = (data) => this.broadcast('sync', data);

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
                    this.updateTeamLabels(ui.teamLabels);
                }
                if (data.hintsEnabled !== undefined) {
                    this.hintsEnabled = data.hintsEnabled;
                    const toggle = document.getElementById('show-hints-toggle');
                    if (toggle) toggle.checked = this.hintsEnabled;
                }
                ui.teamCfg.style.display = 'block';
                ui.playerList.style.display = 'block';
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
        };

        // ── Setup UI ──
        // Team buttons
""")
        # Indent each line by 8 spaces to correctly align in the class
        setup_logic = "\n".join("        " + l if l else l for l in setup_logic.split("\n"))
        new_lines.append(setup_logic + "\n")
        
        # Now find where the old Team Buttons started, skipping the rest of the old initSetup up to team buttons
        end_init_search = lines.index("        // Team buttons\n")
        skip_to = end_init_search + 1
        in_init_setup = False
        continue

    if "        const renderSetupState = () => {" in line:
        # We need to skip the rendering of the old setup logic and replace it with our peer logic
        # But wait, our new Python code already replaced down to `// Team buttons`
        pass
        
    if "        // ── Peer events ──" in line:
        # We skip everything until "    updateTeamLabels(container) {"
        # Then we insert our new methods, connectToHost, setupConnection, sendTo, broadcast
        skip_to = [idx for idx, l in enumerate(lines) if "    updateTeamLabels(container) {" in l][0]
        new_methods = textwrap.dedent("""\
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === 'visible') {
                if (!this.isHost && (!this.hostConnection || !this.hostConnection.open)) {
                    document.getElementById('setup-status').innerText = "Resuming session...";
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
        
        conn.on('open', () => {
            if (this.isHost) {
                if (!this.peers.includes(conn.peer)) {
                    this.peers.push(conn.peer);
                }
                this.connections[conn.peer] = conn;
                
                statusEl.innerText = `${this.peers.length + 1} players connected`;
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
                this.handleData('name', leaverName + ' (Disconnected)', conn.peer);
                if (this.started) {
                    this.log(`❌ ${leaverName} disconnected.`);
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

""")
        # Indent each line by 4 spaces
        new_methods_indented = ""
        for i2, line2 in enumerate(new_methods.split('\n')):
            if line2 == "    }":
                new_methods_indented += "    }\n\n"
            else:
                new_methods_indented += "    " + line2 + "\n"
        new_lines.append(new_methods_indented)
        continue

    if "        this.hand = hands['host'];" in line:
        new_lines.append("        this.hands = hands;\n")
        new_lines.append(line)
        continue

    new_lines.append(line)

with open('game.js', 'w', encoding='utf-8') as f:
    f.writelines(new_lines)
