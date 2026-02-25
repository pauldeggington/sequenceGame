/**
 * Sequence P2P Game – Trystero (serverless P2P)
 * ─────────────────────────────────────────────
 * Flow:
 *  1. Setup screen: host generates room → share link → pick teams → start
 *  2. Game screen:  board + hand, no opponent hand shown
 */

import { joinRoom, selfId } from 'https://esm.run/trystero';

// ── Constants ─────────────────────────────────────────────────
const BOARD_LAYOUT = [
    ["FREE", "2S", "3S", "4S", "5S", "10D", "QD", "KD", "AD", "FREE"],
    ["6C", "5C", "4C", "3C", "2C", "4S", "5S", "6S", "7S", "AC"],
    ["7C", "AS", "2D", "3D", "4D", "KC", "QC", "10C", "8S", "KC"],
    ["8C", "KC", "6C", "5C", "4C", "9H", "8H", "9C", "9S", "QC"],
    ["9C", "QS", "7C", "6H", "5H", "2H", "7H", "8C", "10S", "10C"],
    ["AS", "7H", "9D", "AH", "4H", "3H", "KH", "10D", "6H", "2D"],
    ["KS", "8H", "8D", "2C", "3C", "10H", "QH", "QD", "5H", "3D"],
    ["QS", "9H", "7D", "6D", "5D", "AC", "AD", "KD", "4H", "4D"],
    ["10S", "10H", "QH", "KH", "AH", "3S", "2S", "2H", "3H", "3D"],
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
        this.room = null;
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

        // Trystero senders
        this.sendGameStart = null;
        this.sendMove = null;
        this.sendSync = null;

        this.initSetup();
    }

    // ══════════════════════════════════════
    // SETUP SCREEN
    // ══════════════════════════════════════
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

        // Name input
        nameInput.addEventListener('input', () => {
            this.myName = nameInput.value.trim();
            if (this.sendName) this.sendName(this.myName);
            renderSetupState();
        });

        // Determine room ID
        let roomId = window.location.hash.substring(1);

        if (roomId) {
            this.isHost = false;
            statusEl.innerText = "Joining room...";
        } else {
            roomId = genId(8);
            window.location.hash = roomId;
            this.isHost = true;
            statusEl.innerText = "Room created!";
        }

        // Join Trystero room
        this.room = joinRoom({ appId: 'sequence-game-p2p-2025' }, roomId);

        // Create all actions
        const [sendGameStart, getGameStart] = this.room.makeAction('gameStart');
        const [sendMove, getMove] = this.room.makeAction('move');
        const [sendSync, getSync] = this.room.makeAction('sync');
        const [sendConfig, getConfig] = this.room.makeAction('config');
        const [sendName, getName] = this.room.makeAction('name');

        this.sendGameStart = sendGameStart;
        this.sendMove = sendMove;
        this.sendSync = sendSync;
        this.sendName = sendName;

        // Receive name updates from peers
        getName((name, peerId) => {
            this.peerNames[peerId] = name;
            renderSetupState();
        });

        // ── Setup UI ──
        // Team buttons
        document.querySelectorAll('.team-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.team-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                this.teamCount = parseInt(btn.dataset.teams);
                this.updateTeamLabels(teamLabels);
                // Tell peers about config change
                sendConfig({ teamCount: this.teamCount });
            });
        });

        // Start button (host only)
        startBtn.addEventListener('click', () => {
            this.startGame();
        });

        // Show invite link (host)
        const shareUrl = `${window.location.origin}${window.location.pathname}#${roomId}`;

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

        // ── Peer events ──
        this.room.onPeerJoin(peerId => {
            this.peers.push(peerId);

            // Send my name to the new peer
            if (this.myName) sendName(this.myName, peerId);

            if (this.isHost) {
                statusEl.innerText = `${this.peers.length + 1} players connected`;
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
                playerList.style.display = 'block';
                startBtn.style.display = 'block';
                sendConfig({ teamCount: this.teamCount }, peerId);
            } else {
                statusEl.innerText = "Connected! Waiting for host to start...";
                waitMsg.style.display = 'block';
                playerList.style.display = 'block';
            }

            renderSetupState();
        });

        this.room.onPeerLeave(peerId => {
            this.peers = this.peers.filter(p => p !== peerId);
            const leaverName = this.peerNames[peerId] || 'A player';
            delete this.peerNames[peerId];
            renderSetupState();

            if (this.started) {
                this.log(`❌ ${leaverName} disconnected.`);
            }
        });

        // Config updates from host
        getConfig((data) => {
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
        });

        // Handle hint toggle change
        const hintToggle = document.getElementById('show-hints-toggle');
        hintToggle.addEventListener('change', () => {
            this.hintsEnabled = hintToggle.checked;
            if (this.isHost) {
                sendConfig({ hintsEnabled: this.hintsEnabled });
            }
        });

        // Game start from host
        getGameStart((data) => {
            // Reset local state for next round
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
        });

        getMove((data) => {
            this.applyOpponentMove(data);
            this.currentTurn = data.nextTurn;
            this.updateTurnUI();
        });

        getSync((data) => {
            this.sequences = data.sequences;
            this.updateScoreUI();
            this.renderBoard();
            if (data.winner) {
                this.currentTurn = null;
                this.showWinPopup(data.winner);
            }
        });

        // Host-only: show invite immediately
        if (this.isHost) {
            inviteBox.style.display = 'block';
            inviteUrl.value = shareUrl;
            inviteUrl.addEventListener('click', () => {
                inviteUrl.select();
                navigator.clipboard.writeText(shareUrl).then(() => {
                    const label = document.querySelector('.invite-label');
                    const originalText = label.innerText;
                    label.innerText = '📋 Copied to clipboard!';
                    label.style.color = 'var(--gold)';
                    setTimeout(() => {
                        label.innerText = originalText;
                        label.style.color = '';
                    }, 2000);
                });
            });
            teamCfg.style.display = 'block';
            this.updateTeamLabels(teamLabels);
            renderSetupState();
        }

        // Play Again Button
        const playAgainBtn = document.getElementById('play-again-btn');
        const playAgainWait = document.getElementById('play-again-waiting');
        if (playAgainBtn) {
            playAgainBtn.addEventListener('click', () => {
                if (this.isHost) {
                    // Host resets board and broadcasts a new game
                    this.startGame();
                } else {
                    // Client simply waits for the host
                    playAgainWait.style.display = 'block';
                    playAgainBtn.style.display = 'none';
                }
            });
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

        this.initGameElements();
        this.renderBoard();
        this.renderHand();
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
    renderBoard() {
        if (!this.boardEl) return;
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
                if (this.hintsEnabled && !this.jackMode) {
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

    renderHand() {
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
                isTwoEye ? 'jack-two-eye' : ''
            ].filter(Boolean).join(' ');

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

            cardEl.onclick = () => {
                if (this.currentTurn !== this.myColor) return;

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

            cardEl.onmouseenter = () => {
                if (this.currentTurn !== this.myColor || !this.hintsEnabled) return;
                this.hoveredCardIndex = index;
                this.renderBoard();
            };

            cardEl.onmouseleave = () => {
                if (this.hoveredCardIndex === index) {
                    this.hoveredCardIndex = null;
                    this.renderBoard();
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
                updated = true;
            }
        }

        this.updateScoreUI();

        const winTarget = this.teamCount === 3 ? 1 : 2;
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

    log(msg) {
        if (!this.logEl) return;
        const el = document.createElement('div');
        el.className = 'log-entry';
        el.innerText = msg;
        this.logEl.prepend(el);
    }
}

// ── Boot ──
new SequenceGame();
