/**
 * 神話暗棋：升級覺醒 (Mythic Dark Chess)
 * 核心遊戲邏輯
 */

const PIECE_TYPES = {
    '帥': { value: 7, count: 1, name: '帥/將' },
    '仕': { value: 6, count: 2, name: '仕/士' },
    '相': { value: 5, count: 2, name: '相/象' },
    '俥': { value: 4, count: 2, name: '俥/車' },
    '傌': { value: 3, count: 2, name: '傌/馬' },
    '砲': { value: 2, count: 2, name: '砲/炮' },
    '兵': { value: 1, count: 5, name: '兵/卒' }
};

const BOARD_ROWS = 8;
const BOARD_COLS = 4;

class Game {
    constructor() {
        this.board = []; // 32 slots
        this.turn = 'red'; // 'red' or 'black'
        this.selectedTile = null;
        this.isGameOver = false;
        this.gameMode = 'pve'; // 'pvp' or 'pve'
        this.aiDifficulty = 'amateur';
        this.captured = { red: [], black: [] };
        this.history = []; // 歷史紀錄堆疊
        this.isWaitingForAI = false;
        
        this.init();
    }

    init() {
        this.setupBoard();
        this.renderBoard();
        this.setupEventListeners();
        this.updateStatus();
    }

    saveHistory() {
        // 存儲當前狀態的深拷貝
        const state = JSON.stringify({
            board: this.board,
            turn: this.turn,
            captured: this.captured,
            isGameOver: this.isGameOver
        });
        this.history.push(state);
    }

    undo() {
        if (this.isWaitingForAI || this.history.length === 0) return;

        const restore = () => {
            const lastState = JSON.parse(this.history.pop());
            this.board = lastState.board;
            this.turn = lastState.turn;
            this.captured = lastState.captured;
            this.isGameOver = lastState.isGameOver;
        };

        // 執行回溯
        restore();

        // 如果是人機模式且現在輪到 AI (代表剛才玩家下完棋)，或者現在輪到玩家 (代表剛才 AI 下完棋)
        // 為了讓玩家回到自己的回合，我們通常需要連續回溯兩步
        if (this.gameMode === 'pve' && this.history.length > 0) {
            // 如果回溯一步後發現還是 AI 的回合，再回溯一步
            if (this.turn === 'black') {
                restore();
            }
        }

        this.selectedTile = null;
        this.updateStatus();
        this.updateGraveyard();
        this.renderBoard();
        this.playSound('move');
    }

    setupBoard() {
        const pieces = [];
        const types = ['帥', '仕', '相', '俥', '傌', '砲', '兵'];
        
        // 建立紅黑雙方棋子
        ['red', 'black'].forEach(side => {
            types.forEach(type => {
                const count = PIECE_TYPES[type].count;
                const displayChar = this.getChar(type, side);
                for (let i = 0; i < count; i++) {
                    pieces.push({
                        type: type,
                        char: displayChar,
                        side: side,
                        isFlipped: false,
                        isUpgraded: false,
                        cooldown: 0, // 技能冷卻 (0 為可用)
                        livesLeft: type === '兵' ? 1 : 0
                    });
                }
            });
        });

        // 洗牌
        for (let i = pieces.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
        }

        this.board = pieces;
    }

    getChar(type, side) {
        const map = {
            'red': { '帥': '帥', '仕': '仕', '相': '相', '俥': '俥', '傌': '傌', '砲': '砲', '兵': '兵' },
            'black': { '帥': '將', '仕': '士', '相': '象', '俥': '車', '傌': '馬', '砲': '炮', '兵': '卒' }
        };
        return map[side][type];
    }

    renderBoard() {
        const boardEl = document.getElementById('board');
        boardEl.innerHTML = '';
        
        this.board.forEach((piece, index) => {
            const tile = document.createElement('div');
            tile.className = 'tile';
            tile.dataset.index = index;

            if (piece) {
                const pieceEl = document.createElement('div');
                pieceEl.className = `piece ${piece.side} ${piece.isFlipped ? 'flipped' : ''} ${piece.isUpgraded ? 'upgraded' : ''} ${piece.cooldown > 0 ? 'cooldown' : ''}`;
                
                const front = document.createElement('div');
                front.className = 'piece-face piece-front';
                front.innerText = piece.char;

                const back = document.createElement('div');
                back.className = 'piece-face piece-back';

                pieceEl.appendChild(front);
                pieceEl.appendChild(back);
                tile.appendChild(pieceEl);
            }

            boardEl.appendChild(tile);
        });
    }

    setupEventListeners() {
        document.getElementById('board').addEventListener('click', (e) => {
            const tile = e.target.closest('.tile');
            if (!tile) return;
            this.handleTileClick(parseInt(tile.dataset.index), true); // 標記為玩家手動點擊
        });

        document.getElementById('guide-btn').addEventListener('click', () => {
            document.getElementById('main-game').classList.add('hidden');
            document.getElementById('guide-page').classList.remove('hidden');
            this.initGuideAnimations();
        });

        document.getElementById('back-to-game').addEventListener('click', () => {
            document.getElementById('guide-page').classList.add('hidden');
            document.getElementById('main-game').classList.remove('hidden');
            this.stopGuideAnimations();
        });

        document.getElementById('undo-btn').addEventListener('click', () => {
            this.undo();
        });

        document.getElementById('reset-btn').addEventListener('click', () => {
            if (confirm('確定要重新開始遊戲嗎？')) location.reload();
        });

        document.getElementById('settings-btn').addEventListener('click', () => {
            document.getElementById('settings-modal').classList.remove('hidden');
        });

        document.getElementById('close-settings').addEventListener('click', () => {
            this.gameMode = document.getElementById('mode-select').value;
            this.aiDifficulty = document.getElementById('difficulty-select').value;
            document.getElementById('game-mode-display').innerText = 
                this.gameMode === 'pvp' ? '人 vs 人' : `人 vs AI (${this.getDiffName(this.aiDifficulty)})`;
            document.getElementById('settings-modal').classList.add('hidden');
        });
    }

    getDiffName(diff) {
        const names = { 'novice': '新手', 'amateur': '業餘', 'pro': '職業', 'god': '神手' };
        return names[diff];
    }

    handleTileClick(index, isManual = false) {
        if (this.isGameOver) return;
        
        // 如果是玩家手動點擊，且目前是 AI 回合，則攔截
        if (isManual && (this.isWaitingForAI || (this.gameMode === 'pve' && this.turn === 'black'))) {
            return;
        }
        
        const piece = this.board[index];

        // 1. 翻棋
        if (piece && !piece.isFlipped) {
            if (this.selectedTile !== null) {
                this.deselect();
            }
            this.flipPiece(index);
            this.endTurn();
            return;
        }

        // 2. 選擇棋子
        if (piece && piece.isFlipped && piece.side === this.turn) {
            if (this.selectedTile === index) {
                this.deselect();
            } else {
                this.selectTile(index);
            }
            return;
        }

        // 3. 移動或吃子
        if (this.selectedTile !== null) {
            if (this.tryMove(this.selectedTile, index)) {
                this.endTurn();
            } else {
                // 如果點擊的是自己的另一顆棋子，切換選擇
                if (piece && piece.isFlipped && piece.side === this.turn) {
                    this.selectTile(index);
                }
            }
        }
    }

    selectTile(index) {
        this.deselect();
        this.selectedTile = index;
        document.querySelectorAll('.tile')[index].classList.add('selected');
        this.playSound('select');
    }

    deselect() {
        if (this.selectedTile !== null) {
            document.querySelectorAll('.tile')[this.selectedTile].classList.remove('selected');
            this.selectedTile = null;
        }
    }

    flipPiece(index) {
        this.saveHistory();
        this.board[index].isFlipped = true;
        this.renderBoard();
        this.playSound('flip');
    }

    tryMove(from, to) {
        const piece = this.board[from];
        const target = this.board[to];

        // 基本規則檢查
        if (!this.isValidTarget(from, to)) return false;

        if (!target) {
            // 移動到空格
            if (this.canMoveToEmpty(from, to)) {
                this.movePiece(from, to);
                return true;
            }
        } else {
            // 吃子嘗試
            if (this.canCapture(from, to)) {
                this.capturePiece(from, to);
                return true;
            }
        }

        return false;
    }

    isValidTarget(from, to) {
        // 不能原地踏步
        if (from === to) return false;
        // 目標不能是自己的棋子
        if (this.board[to] && this.board[to].side === this.board[from].side) return false;
        return true;
    }

    // --- 這裡之後會實作複雜的技能規則 ---

    canMoveToEmpty(from, to) {
        const piece = this.board[from];
        const { r: r1, c: c1 } = this.getRC(from);
        const { r: r2, c: c2 } = this.getRC(to);
        const dr = Math.abs(r1 - r2);
        const dc = Math.abs(c1 - c2);

        // 升級後的帥/將：可移動 1 格 (含對角線)
        if (piece.isUpgraded && piece.type === '帥') {
            return (dr <= 1 && dc <= 1);
        }

        // 一般移動：上下左右一格
        return (dr + dc === 1);
    }

    canCapture(from, to) {
        const piece = this.board[from];
        const target = this.board[to];
        
        // 只能吃已翻開的棋子
        if (!target || !target.isFlipped) return false;

        const { r: r1, c: c1 } = this.getRC(from);
        const { r: r2, c: c2 } = this.getRC(to);
        const dr = Math.abs(r1 - r2);
        const dc = Math.abs(c1 - c2);

        // --- 升級後的特殊技能 ---
        if (piece.isUpgraded && piece.cooldown === 0) {
            // 1. 帥/將：對角線吃子 (依然不能吃兵)
            if (piece.type === '帥' && dr === 1 && dc === 1) {
                return target.type !== '兵';
            }

            // 2. 仕/士：對角線「越級刺殺」
            if (piece.type === '仕' && dr === 1 && dc === 1) return true;

            // 4. 俥/車：衝鋒
            if (piece.type === '俥' && (dr === 0 || dc === 0) && this.countPiecesBetween(from, to) === 0) return true;

            // 5. 傌/馬：凌空
            if (piece.type === '傌' && (dr === 2 || dc === 2) && (dr === 0 || dc === 0) && this.countPiecesBetween(from, to) === 1) return true;

            // 6. 砲/炮：神砲
            if (piece.type === '砲' && (dr === 0 || dc === 0) && this.countPiecesBetween(from, to) >= 1) return true;
        }

        // --- 普通吃法 (含冷卻期間的等級壓制) ---
        // 炮的特殊吃法 (跳過一子)
        if (piece.type === '砲') {
            const count = this.countPiecesBetween(from, to);
            return count === 1 && (dr === 0 || dc === 0);
        }

        // 一般等級壓制
        if (dr + dc === 1) {
            return this.compareRank(piece, target);
        }
        
        return false;
    }

    checkAmbush(targetIndex, side) {
        const { r, c } = this.getRC(targetIndex);
        const neighbors = [
            {r: r-1, c: c}, {r: r+1, c: c}, {r: r, c: c-1}, {r: r, c: c+1}
        ];
        
        let soldierCount = 0;
        neighbors.forEach(n => {
            if (n.r >= 0 && n.r < BOARD_ROWS && n.c >= 0 && n.c < BOARD_COLS) {
                const idx = n.r * BOARD_COLS + n.c;
                const p = this.board[idx];
                if (p && p.side === side && p.type === '兵' && p.isFlipped) {
                    soldierCount++;
                }
            }
        });
        return soldierCount >= 2; // 兩隻兵卒埋伏
    }

    compareRank(p1, p2) {
        // 帥不能吃兵
        if (p1.type === '帥' && p2.type === '兵') return false;
        // 兵可以吃帥
        if (p1.type === '兵' && p2.type === '帥') return true;
        // 一般等級壓制
        return PIECE_TYPES[p1.type].value >= PIECE_TYPES[p2.type].value;
    }

    movePiece(from, to) {
        this.saveHistory();
        const piece = this.board[from];
        // 如果使用了特殊移動 (如帥的對角線)，進入冷卻
        const { r: r1, c: c1 } = this.getRC(from);
        const { r: r2, c: c2 } = this.getRC(to);
        if (piece.isUpgraded && piece.type === '帥' && Math.abs(r1-r2) === 1 && Math.abs(c1-c2) === 1) {
            piece.cooldown = 2; // 設定冷卻 2 (因為 endTurn 會立刻減 1)
        }

        this.board[to] = this.board[from];
        this.board[from] = null;
        this.deselect();
        this.renderBoard();
        this.playSound('move');
    }

    capturePiece(from, to) {
        this.saveHistory();
        const attacker = this.board[from];
        const victim = this.board[to];

        // 檢查是否使用了特殊技能吃子 (越級、跳躍、對角線)
        const isSpecialMove = this.isSpecialMove(from, to);

        // 兵/卒的特殊防禦：兩命機制
        if (victim.type === '兵' && victim.isUpgraded && victim.livesLeft > 0) {
            this.handleSoldierRetreat(to);
            if (attacker.isUpgraded && isSpecialMove) attacker.cooldown = 2; 
            return; 
        }

        // 執行吃子
        this.executeCapture(from, to);
        if (attacker.isUpgraded && isSpecialMove) attacker.cooldown = 2;

        // 相/象的重踏技能：連帶吃掉後方棋子
        if (attacker.isUpgraded && attacker.type === '相' && attacker.cooldown === 0) {
            this.handleElephantTrample(from, to);
            attacker.cooldown = 2; // 重踏也是特殊技能
        }
    }

    isSpecialMove(from, to) {
        const p = this.board[from];
        const t = this.board[to];
        const { r: r1, c: c1 } = this.getRC(from);
        const { r: r2, c: c2 } = this.getRC(to);
        const dr = Math.abs(r1 - r2);
        const dc = Math.abs(c1 - c2);

        // 對角線吃子
        if (dr === 1 && dc === 1) return true;
        // 長程或跳躍吃子
        if (dr >= 2 || dc >= 2) return true;
        // 埋伏吃子
        if (p.type === '兵' && !this.compareRank(p, t)) return true;
        
        return false;
    }

    executeCapture(from, to) {
        const attacker = this.board[from];
        const victim = this.board[to];

        if (!attacker.isUpgraded) {
            attacker.isUpgraded = true;
            this.playSound('upgrade');
        }

        this.captured[attacker.side].push(victim);
        this.updateGraveyard();
        
        this.board[to] = attacker;
        this.board[from] = null;
        
        this.deselect();
        this.renderBoard();
        this.playSound('capture');
        this.checkWin();
    }

    handleSoldierRetreat(index) {
        const victim = this.board[index];
        const { r, c } = this.getRC(index);
        const neighbors = [
            {r: r-1, c: c}, {r: r+1, c: c}, {r: r, c: c-1}, {r: r, c: c+1}
        ];
        
        const emptySlots = neighbors.filter(n => {
            if (n.r < 0 || n.r >= BOARD_ROWS || n.c < 0 || n.c >= BOARD_COLS) return false;
            return this.board[n.r * BOARD_COLS + n.c] === null;
        });

        if (emptySlots.length > 0) {
            const escape = emptySlots[Math.floor(Math.random() * emptySlots.length)];
            const targetIdx = escape.r * BOARD_COLS + escape.c;
            this.board[targetIdx] = victim;
            this.board[index] = null;
            victim.livesLeft--;
            this.playSound('move');
            alert('兵卒觸發【難纏】：撤退一格！');
            this.renderBoard();
        } else {
            // 無路可退，直接死亡
            this.executeCapture(this.selectedTile, index);
        }
    }

    handleElephantTrample(from, to) {
        const { r: r1, c: c1 } = this.getRC(from);
        const { r: r2, c: c2 } = this.getRC(to);
        const dr = r2 - r1;
        const dc = c2 - c1;
        const tr = r2 + dr;
        const tc = c2 + dc;

        if (tr >= 0 && tr < BOARD_ROWS && tc >= 0 && tc < BOARD_COLS) {
            const trIdx = tr * BOARD_COLS + tc;
            const extraVictim = this.board[trIdx];
            // 修改：必須是已翻開的棋子才能被重踏
            if (extraVictim && extraVictim.isFlipped && extraVictim.side !== this.board[to].side) {
                // 檢查是否為低階棋子 (比較等級)
                if (PIECE_TYPES[extraVictim.type].value < PIECE_TYPES['相'].value) {
                    this.captured[this.board[to].side].push(extraVictim);
                    this.board[trIdx] = null;
                    this.playSound('capture');
                    alert('相觸發【重踏】：連帶震碎後方棋子！');
                    this.renderBoard();
                }
            }
        }
    }

    getRC(index) {
        return { r: Math.floor(index / BOARD_COLS), c: index % BOARD_COLS };
    }

    countPiecesBetween(from, to) {
        const { r: r1, c: c1 } = this.getRC(from);
        const { r: r2, c: c2 } = this.getRC(to);
        if (r1 !== r2 && c1 !== c2) return -1;

        let count = 0;
        if (r1 === r2) {
            const start = Math.min(c1, c2);
            const end = Math.max(c1, c2);
            for (let i = start + 1; i < end; i++) {
                if (this.board[r1 * BOARD_COLS + i]) count++;
            }
        } else {
            const start = Math.min(r1, r2);
            const end = Math.max(r1, r2);
            for (let i = start + 1; i < end; i++) {
                if (this.board[i * BOARD_COLS + c1]) count++;
            }
        }
        return count;
    }

    updateStatus() {
        const indicator = document.getElementById('turn-indicator');
        const text = indicator.querySelector('.turn-text');
        indicator.className = this.turn === 'red' ? 'turn-red' : 'turn-black';
        text.innerText = this.turn === 'red' ? '紅方回合' : '黑方回合';
    }

    updateGraveyard() {
        ['red', 'black'].forEach(side => {
            const list = document.getElementById(`${side}-captured`);
            list.innerHTML = '';
            this.captured[side].forEach(p => {
                const item = document.createElement('div');
                item.className = `captured-item ${p.side}`;
                item.innerText = p.char;
                list.appendChild(item);
            });
        });
    }

    endTurn() {
        // 更新所有棋子的冷卻時間 (目前回合方的棋子減冷卻)
        this.board.forEach(p => {
            if (p && p.side === this.turn && p.cooldown > 0) {
                p.cooldown--;
            }
        });

        this.turn = this.turn === 'red' ? 'black' : 'red';
        this.updateStatus();
        this.renderBoard(); // 重新渲染以更新冷卻視覺
        
        if (this.gameMode === 'pve' && this.turn === 'black' && !this.isGameOver) {
            this.isWaitingForAI = true;
            setTimeout(() => {
                this.makeAIMove();
                this.isWaitingForAI = false;
            }, 600);
        }
    }

    checkWin() {
        // 簡單判斷：某方棋子全部被吃掉
        const redLeft = this.board.filter(p => p && p.side === 'red').length;
        const blackLeft = this.board.filter(p => p && p.side === 'black').length;
        
        if (redLeft === 0) {
            alert('黑方勝利！');
            this.isGameOver = true;
        } else if (blackLeft === 0) {
            alert('紅方勝利！');
            this.isGameOver = true;
        }
    }

    // 音效播放 (暫時使用模擬音效)
    playSound(type) {
        console.log('Playing sound:', type);
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        const now = ctx.currentTime;
        
        switch(type) {
            case 'flip':
                osc.frequency.setValueAtTime(400, now);
                osc.frequency.exponentialRampToValueAtTime(600, now + 0.1);
                gain.gain.setValueAtTime(0.1, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
                osc.start(now);
                osc.stop(now + 0.2);
                break;
            case 'move':
                osc.frequency.setValueAtTime(300, now);
                gain.gain.setValueAtTime(0.05, now);
                gain.gain.linearRampToValueAtTime(0, now + 0.1);
                osc.start(now);
                osc.stop(now + 0.1);
                break;
            case 'capture':
                osc.type = 'square';
                osc.frequency.setValueAtTime(200, now);
                osc.frequency.exponentialRampToValueAtTime(50, now + 0.3);
                gain.gain.setValueAtTime(0.1, now);
                gain.gain.linearRampToValueAtTime(0, now + 0.3);
                osc.start(now);
                osc.stop(now + 0.3);
                break;
            case 'upgrade':
                osc.frequency.setValueAtTime(523.25, now); // C5
                osc.frequency.exponentialRampToValueAtTime(1046.5, now + 0.5);
                gain.gain.setValueAtTime(0.1, now);
                gain.gain.linearRampToValueAtTime(0, now + 0.5);
                osc.start(now);
                osc.stop(now + 0.5);
                break;
        }
    }

    makeAIMove() {
        if (this.isGameOver) return;

        let bestMove = null;
        
        switch(this.aiDifficulty) {
            case 'novice':
                bestMove = this.getRandomMove();
                break;
            case 'amateur':
                bestMove = this.getMinimaxMove(1);
                break;
            case 'pro':
                bestMove = this.getMinimaxMove(3);
                break;
            case 'god':
                bestMove = this.getMinimaxMove(4); // 降低到 4 層以確保效能與穩定
                break;
        }

        if (bestMove) {
            if (bestMove.type === 'flip') {
                this.handleTileClick(bestMove.index);
            } else {
                this.handleTileClick(bestMove.from);
                setTimeout(() => this.handleTileClick(bestMove.to), 400);
            }
        }
    }

    getRandomMove() {
        const moves = this.getAllValidMoves('black');
        const unflipped = this.getUnflippedIndices();
        
        if (unflipped.length > 0 && Math.random() > 0.3) {
            return { type: 'flip', index: unflipped[Math.floor(Math.random() * unflipped.length)] };
        }
        if (moves.length > 0) {
            return { type: 'move', ...moves[Math.floor(Math.random() * moves.length)] };
        }
        if (unflipped.length > 0) {
            return { type: 'flip', index: unflipped[Math.floor(Math.random() * unflipped.length)] };
        }
        return null;
    }

    getMinimaxMove(depth) {
        let bestScore = -Infinity;
        let bestMove = null;
        
        const moves = this.getAllValidMoves('black');
        const unflipped = this.getUnflippedIndices();

        // 1. 如果完全沒棋可走，必翻棋
        if (moves.length === 0 && unflipped.length > 0) {
            return { type: 'flip', index: unflipped[Math.floor(Math.random() * unflipped.length)] };
        }

        // 2. 評估所有走法
        moves.forEach(move => {
            const originalBoard = JSON.parse(JSON.stringify(this.board));
            this.simulateMove(move.from, move.to);
            let score = this.minimax(depth - 1, -Infinity, Infinity, false);
            this.board = originalBoard;

            if (score > bestScore) {
                bestScore = score;
                bestMove = { type: 'move', ...move };
            }
        });

        // 3. 翻棋決策：
        // 如果沒有找到任何移動，或最好的移動評分太低
        const flipThreshold = 100; 
        if (unflipped.length > 0) {
            // 如果連一個移動都沒找到，或者最好的移動真的很爛，就翻棋
            if (!bestMove || bestScore < flipThreshold || Math.random() < 0.1) {
                return { type: 'flip', index: unflipped[Math.floor(Math.random() * unflipped.length)] };
            }
        }

        // 4. 保底：如果真的什麼都沒選到，強制翻棋或隨機走
        if (!bestMove) {
            if (unflipped.length > 0) return { type: 'flip', index: unflipped[0] };
            if (moves.length > 0) return { type: 'move', ...moves[0] };
        }

        return bestMove;
    }

    minimax(depth, alpha, beta, isMaximizing) {
        if (depth === 0 || this.isGameOver) {
            return this.evaluateBoard();
        }

        if (isMaximizing) {
            let maxEval = -Infinity;
            const moves = this.getAllValidMoves('black');
            for (let move of moves) {
                const originalBoard = JSON.parse(JSON.stringify(this.board));
                this.simulateMove(move.from, move.to);
                let evaluation = this.minimax(depth - 1, alpha, beta, false);
                this.board = originalBoard;
                maxEval = Math.max(maxEval, evaluation);
                alpha = Math.max(alpha, evaluation);
                if (beta <= alpha) break;
            }
            return maxEval;
        } else {
            let minEval = Infinity;
            const moves = this.getAllValidMoves('red');
            for (let move of moves) {
                const originalBoard = JSON.parse(JSON.stringify(this.board));
                this.simulateMove(move.from, move.to);
                let evaluation = this.minimax(depth - 1, alpha, beta, true);
                this.board = originalBoard;
                minEval = Math.min(minEval, evaluation);
                beta = Math.min(beta, evaluation);
                if (beta <= alpha) break;
            }
            return minEval;
        }
    }

    evaluateBoard() {
        let score = 0;
        this.board.forEach((p, i) => {
            if (!p) return;
            if (!p.isFlipped) {
                // 對於未翻開的棋子，給予微小的基礎分，鼓勵 AI 去翻
                score += (p.side === 'black' ? 1 : -1);
                return;
            }

            let val = PIECE_TYPES[p.type].value * 20;
            if (p.isUpgraded) val += 30;
            if (p.cooldown > 0) val -= 10;
            if (p.type === '兵' && p.livesLeft > 0) val += 10;

            // 位置評估：佔據中心位置較佳
            const { r, c } = this.getRC(i);
            const distFromCenter = Math.abs(r - 3.5) + Math.abs(c - 1.5);
            val += (5 - distFromCenter);

            // 安全性評估：如果會被對方吃掉，大幅減分
            if (this.isPieceUnderThreat(i, p.side)) {
                val -= PIECE_TYPES[p.type].value * 15;
            }

            score += (p.side === 'black' ? val : -val);
        });
        return score;
    }

    isPieceUnderThreat(index, side) {
        const enemySide = side === 'red' ? 'black' : 'red';
        for (let i = 0; i < 32; i++) {
            const p = this.board[i];
            if (p && p.side === enemySide && p.isFlipped) {
                if (this.tryMovePreview(i, index)) return true;
            }
        }
        return false;
    }

    simulateMove(from, to) {
        // 使用更輕量的方式模擬，避免深拷貝整個對象
        const attacker = this.board[from];
        this.board[to] = attacker;
        this.board[from] = null;
    }

    // 優化 getAllValidMoves，只檢查有意義的範圍
    getAllValidMoves(side) {
        const moves = [];
        this.board.forEach((p, i) => {
            if (p && p.side === side && p.isFlipped) {
                const { r, c } = this.getRC(i);
                // 基礎移動：只檢查上下左右與對角線 (暗棋棋盤小，全查其實也還好，但可稍微限制)
                for (let j = 0; j < 32; j++) {
                    if (this.tryMovePreview(i, j)) {
                        moves.push({ from: i, to: j });
                    }
                }
            }
        });
        return moves;
    }

    getUnflippedIndices() {
        const indices = [];
        this.board.forEach((p, i) => {
            if (p && !p.isFlipped) indices.push(i);
        });
        return indices;
    }

    tryMovePreview(from, to) {
        if (!this.isValidTarget(from, to)) return false;
        const target = this.board[to];
        if (!target) return this.canMoveToEmpty(from, to);
        return this.canCapture(from, to);
    }
    // --- 玩法說明與動畫系統 ---
    initGuideAnimations() {
        const guideList = document.getElementById('guide-list');
        guideList.innerHTML = '';
        
        const pieces = [
            { type: '帥', skill: '威震八方', desc: '可對角線移動/吃子（1格），不可吃兵。', demo: 'diagonal' },
            { type: '仕', skill: '越級刺殺', desc: '僅限對角線「越級」吃子。不可直線吃子或單純對角線移動。', demo: 'assassin' },
            { type: '相', skill: '重踏', desc: '吃子後，連帶震碎目標後方的低階已翻開敵棋。', demo: 'trample' },
            { type: '俥', skill: '衝鋒', desc: '直線衝刺越級吃子，不可用於單純移動。', demo: 'rush' },
            { type: '傌', skill: '凌空', desc: '跳過相鄰的一顆棋子越級吃子，不可用於單純移動。', demo: 'leap' },
            { type: '砲', skill: '神砲', desc: '可一次飛越多顆棋子進行遠程打擊。', demo: 'supercannon' },
            { type: '兵', skill: '難纏/埋伏', desc: '兩條命（撤退機制）；兩隻兵夾擊敵棋可越級吃子。', demo: 'ambush' }
        ];

        this.guideTimers = [];

        pieces.forEach(p => {
            const card = document.createElement('div');
            card.className = 'guide-card';
            card.innerHTML = `
                <h3>${p.type} <span class="skill-tag">${p.skill}</span></h3>
                <p class="guide-desc">${p.desc}</p>
                <div class="demo-container">
                    <div class="demo-board" id="demo-${p.type}">
                        ${this.createDemoTiles()}
                    </div>
                </div>
            `;
            guideList.appendChild(card);
            this.startDemo(p.type, p.demo);
        });
    }

    createDemoTiles() {
        let html = '';
        for(let i=0; i<9; i++) html += `<div class="demo-tile"></div>`;
        return html;
    }

    startDemo(type, demoType) {
        const board = document.getElementById(`demo-${type}`);
        const tiles = board.querySelectorAll('.demo-tile');
        
        // 建立示範棋子
        const attacker = document.createElement('div');
        attacker.className = 'demo-piece red gold';
        attacker.innerText = type;
        
        const victim = document.createElement('div');
        victim.className = 'demo-piece black';
        victim.innerText = (type === '帥') ? '卒' : '帥'; // 示範目標

        const run = () => {
            // 重置位置
            if (demoType === 'diagonal') {
                this.setDemoPos(attacker, tiles[8]);
                this.setDemoPos(victim, tiles[4]);
                setTimeout(() => this.setDemoPos(attacker, tiles[4]), 1000);
            } else if (demoType === 'leap') {
                const hurdle = document.createElement('div');
                hurdle.className = 'demo-piece black'; hurdle.innerText = '兵';
                this.setDemoPos(attacker, tiles[6]);
                this.setDemoPos(hurdle, tiles[7]);
                this.setDemoPos(victim, tiles[8]);
                board.appendChild(hurdle);
                setTimeout(() => {
                    this.setDemoPos(attacker, tiles[8]);
                    victim.style.opacity = '0';
                }, 1000);
            } else if (demoType === 'rush') {
                this.setDemoPos(attacker, tiles[6]);
                this.setDemoPos(victim, tiles[0]);
                setTimeout(() => {
                    this.setDemoPos(attacker, tiles[0]);
                    victim.style.opacity = '0';
                }, 1000);
            } else {
                // 簡化通用演示
                this.setDemoPos(attacker, tiles[6]);
                this.setDemoPos(victim, tiles[3]);
                setTimeout(() => {
                    this.setDemoPos(attacker, tiles[3]);
                    victim.style.opacity = '0';
                }, 1000);
            }
            
            this.guideTimers.push(setTimeout(() => {
                victim.style.opacity = '1';
                run();
            }, 3000));
        };

        board.appendChild(attacker);
        board.appendChild(victim);
        run();
    }

    setDemoPos(piece, tile) {
        const rect = tile.getBoundingClientRect();
        const boardRect = tile.parentElement.getBoundingClientRect();
        piece.style.left = (tile.offsetLeft) + 'px';
        piece.style.top = (tile.offsetTop) + 'px';
    }

    stopGuideAnimations() {
        if (this.guideTimers) {
            this.guideTimers.forEach(t => clearTimeout(t));
        }
    }
}

window.onload = () => new Game();
