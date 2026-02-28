import os
import textwrap

# Robustly patch game.js for Sequence multiplayer/host migration
# This script is designed to be idempotent.
with open('game.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

new_lines = []
skip_to = None

# Helper to check if a line (or part of it) already exists in a range
def is_already_present(target_parts, search_lines):
    for l in search_lines:
        if all(part in l for part in target_parts):
            return True
    return False

for i, line in enumerate(lines):
    # Skip lines if we are replacing a block
    if skip_to is not None:
        if i < skip_to:
            continue
        else:
            skip_to = None

    # Replace networking imports
    if "import { joinRoom, selfId } from 'https://esm.run/trystero';" in line:
        new_lines.append("// Networking now uses PeerJS loaded via <script> tag in index.html\n")
        continue

    # Initialize new properties in constructor
    if "this.room = null;" in line:
        new_lines.append(line)
        props = [
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
            "        this.hands = {};         // For reconnects, host saves all hands dealt\n",
            "        this.hostStateBackup = null; // Backup of the game state for migration\n"
        ]
        # Only add props that aren't already there in the next few lines
        next_chunk = "".join(lines[i+1:i+25])
        for p in props:
            if p.strip() not in next_chunk:
                new_lines.append(p)
        continue

    # robust initSetup replacement
    if "    initSetup() {" in line:
        new_lines.append(line)
        setup_logic = textwrap.dedent("""\
        const ui = this.ui;

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

        // Name input
        ui.nameInput.addEventListener('input', () => {
            this.myName = ui.nameInput.value.trim();
            this.broadcast('name', this.myName);
            renderSetupState();
        });

        let roomId = window.location.hash.substring(1);
        const savedRoomId = localStorage.getItem('sequence_roomID');
        const savedIsHost = localStorage.getItem('sequence_isHost');

        const initPeer = () => {
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
                    ui.inviteUrl.onmousedown = () => {
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
                    renderSetupState();
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
        };

        if (roomId) {
            this.isHost = false;
            ui.status.innerText = "Joining room...";
            localStorage.setItem('sequence_roomID', roomId);
            localStorage.setItem('sequence_isHost', 'false');
            initPeer();
        } else if (savedRoomId && savedIsHost === 'true') {
            roomId = savedRoomId;
            window.location.hash = roomId;
            this.isHost = true;
            ui.status.innerText = "Re-hosting room...";
            initPeer();
        } else {
            ui.status.innerText = "";
            ui.createSec.style.display = "block";
            
            ui.createBtn.onclick = () => {
                ui.createSec.style.display = "none";
                roomId = genId(8);
                window.location.hash = roomId;
                this.isHost = true;
                ui.status.innerText = "Room created!";
                localStorage.setItem('sequence_roomID', roomId);
                localStorage.setItem('sequence_isHost', 'true');
                initPeer();
            };
            
            ui.playSingleBtn.onclick = () => {
                this.isSinglePlayer = true;
                this.isHost = true; // Act as host for game logic

                // Set up peers array manually (empty peer for the AI will be built by startGame)
                this.peers = [];
                this.peerNames = {};
                this.playerIDMap = {};

                // Show options instead of starting
                ui.createSec.style.display = 'none';
                ui.teamCfg.style.display = 'block';
                ui.teamCfg.classList.add('single-player-setup');
                ui.startBtn.style.display = 'block';

                // Allow team selection for 1v1 or 1v1v1
                this.updateTeamLabels(ui.teamLabels);
            };
        }

        window.addEventListener("visibilitychange", () => {
            if (document.visibilityState === 'visible' && !this.isHost) {
                if (!this.hostConnection || !this.hostConnection.open) {
                    this.attemptReconnect();
                }
            }
        });
        """)
        # Indent each line by 8 spaces to correctly align in the class
        setup_logic_indented = "\n".join("        " + l if l else l for l in setup_logic.split("\n"))
        new_lines.append(setup_logic_indented + "\n")
        
        # Skip until updateTeamLabels (the end of the setup block)
        try:
            target_idx = [idx for idx, l in enumerate(lines) if "    updateTeamLabels(container) {" in l][0]
            skip_to = target_idx
        except:
            # Fallback if marker not found
            skip_to = i + 1
        continue

    # Check for SequenceGame class start to inject methods
    if "SequenceGame {" in line:
        new_lines.append(line)
        # Only inject if not already there
        if "// ── Peer events ──" not in lines[i+1]:
            new_lines.append("    // ── Peer events ──\n")
            new_methods = textwrap.dedent("""\
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
                    this.lockedSequences = s.lockedSequences || [];

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

                // Remove ghost connections for the same playerID
                for (const pid of [...this.peers]) {
                    if (pid !== peerId && this.playerIDMap[pid] === playerID) {
                        this.peers = this.peers.filter(p => p !== pid);
                        delete this.playerIDMap[pid];
                        delete this.peerNames[pid];
                        if (this.connections[pid]) {
                            this.connections[pid].close();
                            delete this.connections[pid];
                        }
                    }
                }

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
                        lockedSequences: this.lockedSequences,
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
            this.sequenceGrid = Array(10).fill(null).map(() => Array(10).fill(false));
            this.lockedSequences = [];
            this.lastMove = data.lastMove || null;
            if (this.ui && this.ui.seqLines) this.ui.seqLines.innerHTML = '';
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
                this.lockedSequences = data.lockedSequences || [];
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
            if (data.lockedSequences) this.lockedSequences = data.lockedSequences;
            this.updateScoreUI();
            this.renderBoard();
            this.redrawSequenceLines();
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
        } else if (type === 'hostStateBackup') {
            if (!this.isHost) {
                this.hostStateBackup = data;
            }
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

        newConn.on('open', () => {
            clearTimeout(handshakeTimeout);
            this._reconnectAttempts = 0;
            const warningEl = document.getElementById('host-dropped-warning');
            if (warningEl) warningEl.style.display = 'none';
        });

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
        if (ui && ui.status) ui.status.innerText = "Attempting to reconnect...";

        // Show game-screen reconnect warning if game already started
        if (this.started && !this.isHost) {
            const warningEl = document.getElementById('host-dropped-warning');
            const timerEl = document.getElementById('host-reconnect-timer');
            const takeoverBtn = document.getElementById('take-over-host-btn');
            
            if (warningEl) warningEl.style.display = 'block';
            
            // Track reconnect attempts to show Take Over button
            this._reconnectAttempts = (this._reconnectAttempts || 0) + 1;
            
            if (timerEl) {
                timerEl.innerText = `Attempting to reconnect (${this._reconnectAttempts})...`;
            }
            
            if (this._reconnectAttempts > 1 && takeoverBtn && this.hostStateBackup) {
                takeoverBtn.style.display = 'inline-block';
                takeoverBtn.onclick = () => this.takeOverAsHost();
            }
        }

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

    takeOverAsHost() {
        if (!this.hostStateBackup || this.isHost) return;
        
        const roomID = window.location.hash.substring(1);
        if (!roomID) return;

        console.log("Taking over as host for room:", roomID);
        
        // Hide warning UI
        const warningEl = document.getElementById('host-dropped-warning');
        const takeoverBtn = document.getElementById('take-over-host-btn');
        if (warningEl) warningEl.style.display = 'none';
        if (takeoverBtn) takeoverBtn.style.display = 'none';

        // Elevate to host
        this.isHost = true;
        this._reconnecting = false;
        
        // Ensure PeerJS disconnects from the old closed host properly
        if (this.peer && !this.peer.destroyed) {
            this.peer.destroy();
        }

        // Install our backup as the "saved game state" of the room
        localStorage.setItem(`sequence_gameState_${roomID}`, JSON.stringify(this.hostStateBackup));
        
        // Restart session as the new host
        this.startSession(roomID, true);
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
                            lockedSequences: this.lockedSequences,
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

    sendEmoji(emoji) {
        if (this.isSinglePlayer) return;
        this.broadcast('emoji', emoji);
    }

    sendJoin() {
        if (!this.isSinglePlayer && this.hostConnection && this.hostConnection.open) {
            this.hostConnection.send({ type: 'join', data: { name: this.myName, playerID: this.playerID } });
        }
    }

    sendName(name) {
        this.broadcast('name', name);
    }

    sendConfig(config) {
        this.broadcast('config', config);
    }

    sendGameStart(data, pId) {
        if (pId) {
            this.sendTo(pId, 'gameStart', data);
        } else {
            this.broadcast('gameStart', data);
        }
    }

    sendMove(data) {
        this.broadcast('move', data);
    }

    sendSync(data) {
        this.broadcast('sync', data);
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
            
            # Skip until updateTeamLabels
            try:
                target_idx = [idx for idx, l in enumerate(lines) if "    updateTeamLabels(container) {" in l][0]
                skip_to = target_idx
            except:
                skip_to = i + 1
        continue

    # Restore hands on host for reconnect logic
    if "        this.hand = hands['host'];" in line:
        new_lines.append("        this.hands = hands;\n")
        new_lines.append(line)
        continue

    # Periodic game state backup broadcast for migration
    if "localStorage.setItem(`sequence_gameState_${this.currentRoomId}`, JSON.stringify(state));" in line:
        new_lines.append(line)
        # Check if next line already has the broadcast
        if i + 1 < len(lines) and "this.broadcast('hostStateBackup', state);" in lines[i+1]:
            continue
        new_lines.append("        this.broadcast('hostStateBackup', state);\n")
        continue

    new_lines.append(line)

# Write out the patched file
with open('game.js', 'w', encoding='utf-8') as f:
    f.writelines(new_lines)
