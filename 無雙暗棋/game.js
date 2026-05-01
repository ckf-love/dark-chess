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
        this.recentMoves = []; // 舊版禁手（將淘汰）
        this.stateHistory = []; // 新版禁手狀態雜湊
        this.turnCount = 0; // 總回合數
        this.lastMovedTo = null; // 移動後發光提示
        this.isWaitingForRetreat = false; // 等待玩家選擇撤退方向
        this.retreatData = null; // 儲存撤退所需的資訊 { attacker, victim, options }
        this.audioContext = null; // 持久化音效上下文 (修復手機音效)
        this.soundEnabled = true; // 音效開關
        // 沙盒模式狀態
        this.sandboxBoard = new Array(32).fill(null);
        this.selectedPieceDef = null;
        this.sandboxEraseMode = false;
        this.isFromSandbox = false; // 是否由沙盒載入
        this.gameLogs = []; // 對局紀錄日誌
        this.chaseHistory = { red: [], black: [] }; // 追逐歷史紀錄 { side: ["chaserId->victimId", ...] }

        this.init();
    }

    init() {
        this.setupEventListeners();
        this.initMenuListeners();
        this.initExportListener();
        this.updateStatus();
    }

    showPage(pageId) {
        const pages = ['start-page', 'sandbox-page', 'guide-page', 'main-game'];
        pages.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                if (id === pageId) el.classList.remove('hidden');
                else el.classList.add('hidden');
            }
        });

        // 特殊處理：如果是離開遊戲頁面，確保停止 AI 動作（簡單處理：不執行 endTurn）
        if (pageId === 'start-page') {
            this.isGameOver = true;
        }
    }

    initMenuListeners() {
        // 起始頁面按鈕
        document.getElementById('normal-mode-btn').onclick = () => {
            document.getElementById('settings-modal').classList.remove('hidden');
        };

        document.getElementById('wushuang-mode-btn').onclick = () => {
            alert('國士無雙模式開發中~');
        };

        this.isSandboxUnlocked = false;
        const sandboxBtn = document.getElementById('sandbox-mode-btn');
        let sandboxTimer = null;

        let isPressing = false;

        const startPress = (e) => {
            if (this.isSandboxUnlocked) return;
            if (e.type === 'mousedown' && e.button !== 0) return;

            isPressing = true;
            if (sandboxTimer) clearTimeout(sandboxTimer);

            sandboxTimer = setTimeout(() => {
                if (isPressing) {
                    this.isSandboxUnlocked = true;
                    sandboxBtn.classList.add('unlocked');

                    // 視覺回饋：按鈕變綠並更改文字
                    sandboxBtn.style.borderColor = '#4ade80';
                    sandboxBtn.style.boxShadow = '0 0 15px rgba(74, 222, 128, 0.5)';
                    sandboxBtn.style.backgroundColor = 'rgba(74, 222, 128, 0.1)';
                    sandboxBtn.style.color = '#4ade80';
                    sandboxBtn.innerHTML = '🔓 點擊進入測試';

                    // 移除 alert，這樣使用者放開手指時會直接觸發 click 進入測試模式，體驗更流暢
                }
            }, 2500);
        };

        const cancelPress = () => {
            isPressing = false;
            if (sandboxTimer) {
                clearTimeout(sandboxTimer);
                sandboxTimer = null;
            }
        };

        sandboxBtn.addEventListener('touchstart', startPress, { passive: true });
        sandboxBtn.addEventListener('touchend', cancelPress);
        sandboxBtn.addEventListener('touchcancel', cancelPress);

        sandboxBtn.addEventListener('mousedown', startPress);
        sandboxBtn.addEventListener('mouseup', cancelPress);
        sandboxBtn.addEventListener('mouseleave', cancelPress);

        // 點擊事件：負責進入模式或提示鎖定
        sandboxBtn.addEventListener('click', (e) => {
            if (this.isSandboxUnlocked) {
                this.showPage('sandbox-page');
                this.initSandbox();
            } else {
                alert('此模式僅供開發人員使用');
            }
        });


        // 防止手機長按時觸發選單干擾
        sandboxBtn.addEventListener('contextmenu', e => {
            if (!this.isSandboxUnlocked) e.preventDefault();
        });

        document.getElementById('open-guide-btn').onclick = () => {
            this.showPage('guide-page');
            this.initGuideAnimations();
        };

        // 設定彈窗按鈕
        document.getElementById('start-game-confirm').onclick = () => {
            this.gameMode = document.getElementById('mode-select').value;
            this.aiDifficulty = document.getElementById('difficulty-select').value;
            document.getElementById('game-mode-display').innerText =
                this.gameMode === 'pvp' ? '人 vs 人' : `人 vs AI (${this.getDiffName(this.aiDifficulty)})`;
            document.getElementById('settings-modal').classList.add('hidden');

            // 正式開始遊戲
            this.startNewGame();
        };

        document.getElementById('cancel-settings').onclick = () => {
            document.getElementById('settings-modal').classList.add('hidden');
        };

        // 返回主選單按鈕
        document.getElementById('back-from-sandbox').onclick = () => this.showPage('start-page');
        document.getElementById('back-to-menu').onclick = () => {
            this.showPage('start-page');
            this.stopGuideAnimations();
        };
        document.getElementById('back-to-menu-from-game').onclick = () => {
            if (confirm('確定要回到主選單？目前的遊戲進度將遺失。')) {
                this.showPage('start-page');
            }
        };
    }

    startNewGame() {
        this.isGameOver = false;
        this.turn = 'none';
        this.playerSide = null;
        this.selectedTile = null;
        this.history = [];
        this.stateHistory = [];
        this.chaseHistory = { red: [], black: [] };
        this.turnCount = 0;
        this.lastMovedTo = null;
        this.isWaitingForRetreat = false;
        this.isWaitingForAI = false;
        this.captured = { red: [], black: [] };
        this.isFromSandbox = false;
        document.getElementById('return-sandbox-btn').classList.add('hidden');

        this.setupBoard();
        this.renderBoard();
        this.updateStatus();
        this.updateGraveyard();
        this.showPage('main-game');
        this.addLog('start');
    }

    saveHistory() {
        // 存儲當前狀態的深拷貝
        const state = JSON.stringify({
            board: this.board,
            turn: this.turn,
            captured: this.captured,
            isGameOver: this.isGameOver,
            stateHistory: this.stateHistory,
            chaseHistory: JSON.parse(JSON.stringify(this.chaseHistory)),
            turnCount: this.turnCount,
            lastMovedTo: this.lastMovedTo,
            isWaitingForRetreat: this.isWaitingForRetreat,
            retreatData: this.retreatData,
            playerSide: this.playerSide
        });
        this.history.push(state);
    }

    undo() {
        if (this.isWaitingForAI || this.history.length === 0) return;
        this.addLog('undo');

        const restore = () => {
            const lastState = JSON.parse(this.history.pop());
            this.board = lastState.board;
            this.turn = lastState.turn;
            this.captured = lastState.captured;
            this.isGameOver = lastState.isGameOver;
            this.stateHistory = lastState.stateHistory;
            this.chaseHistory = lastState.chaseHistory;
            this.turnCount = lastState.turnCount;
            this.lastMovedTo = lastState.lastMovedTo;
            this.isWaitingForRetreat = lastState.isWaitingForRetreat;
            this.retreatData = lastState.retreatData;
            this.playerSide = lastState.playerSide;
        };

        // 執行回溯
        restore();

        // 如果是人機模式且現在輪到 AI (代表剛才玩家下完棋)，或者現在輪到玩家 (代表剛才 AI 下完棋)
        // 為了讓玩家回到自己的回合，我們通常需要連續回溯兩步
        if (this.gameMode === 'pve' && this.history.length > 0) {
            // 如果回溯一步後發現還是 AI 的回合，再回溯一步
            if (this.turn === this.aiSide) {
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
                        id: `${side}-${type}-${i}`, // 賦予唯一 ID 用於追逐判定
                        type: type,
                        char: displayChar,
                        side: side,
                        isFlipped: false,
                        isUpgraded: false,
                        cooldown: 0, // 技能冷卻 (0 為可用)
                        retreatHitTurn: -1 // 記錄上一次遭到攻擊的回合
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
        this.turn = 'none'; // 動態決定先手
        this.stateHistory = [];
        this.chaseHistory = { red: [], black: [] };
        this.turnCount = 0;
        this.lastMovedTo = null;
        this.isWaitingForRetreat = false;
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

            // 標示玩家手動撤退可選的格子
            if (this.isWaitingForRetreat && this.retreatData && this.retreatData.options.includes(index)) {
                tile.classList.add('retreat-target');
            }

            if (piece) {
                // 加入 last-moved class
                const isLastMoved = (index === this.lastMovedTo) ? 'last-moved' : '';
                const pieceEl = document.createElement('div');
                pieceEl.className = `piece ${piece.side} ${piece.isFlipped ? 'flipped' : ''} ${piece.isUpgraded ? 'upgraded' : ''} ${piece.cooldown > 0 ? 'cooldown' : ''} ${isLastMoved}`;

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
            // 手機音效修復：使用者第一次互動時恢復 AudioContext
            this.resumeAudioContext();
            this.handleTileClick(parseInt(tile.dataset.index), true); // 標記為玩家手動點擊
        });

        document.getElementById('close-repetition').addEventListener('click', () => {
            document.getElementById('repetition-modal').classList.add('hidden');
        });

        // 音效開關
        document.getElementById('sound-toggle').addEventListener('change', (e) => {
            this.soundEnabled = e.target.checked;
        });

        document.getElementById('undo-btn').addEventListener('click', () => {
            this.undo();
        });

        document.getElementById('reset-btn').addEventListener('click', () => {
            if (confirm('確定要重新開始遊戲嗎？')) {
                document.getElementById('settings-modal').classList.remove('hidden');
            }
        });

        // 沙盒模式特定功能
        document.getElementById('clear-sandbox').addEventListener('click', () => {
            this.sandboxBoard = new Array(32).fill(null);
            this.renderSandboxBoard();
        });

        document.getElementById('sandbox-load-game').addEventListener('click', () => {
            if (confirm('確定將此棋盤載入主遊戲？（目前遊戲進度將被清除）')) {
                this.isGameOver = false;
                this.board = JSON.parse(JSON.stringify(this.sandboxBoard));
                // 將所有兵的退避回合重置
                this.board.forEach(p => { if (p) p.retreatHitTurn = -1; });

                this.turn = 'red';
                this.playerSide = 'red'; // 預設沙盒載入後玩家為紅方
                this.selectedTile = null;
                this.history = [];
                this.stateHistory = [];
                this.chaseHistory = { red: [], black: [] };
                this.turnCount = 0;
                this.lastMovedTo = null;
                this.isWaitingForRetreat = false;
                this.captured = { red: [], black: [] };
                this.isFromSandbox = true;

                this.renderBoard();
                this.updateStatus();
                this.updateGraveyard();
                this.showPage('main-game');
                this.showToast('沙盒棋盤已載入！紅方先行。');

                // 顯示返回沙盒按鈕
                document.getElementById('return-sandbox-btn').classList.remove('hidden');
            }
        });

        // 返回測試模式
        document.getElementById('return-sandbox-btn').addEventListener('click', () => {
            if (confirm('確定要返回測試模式嗎？（目前的遊戲進度不會儲存）')) {
                this.showPage('sandbox-page');
            }
        });
    }

    getDiffName(diff) {
        const names = { 'novice': '3歲小童', 'amateur': '小學生', 'pro': '樓下阿嬤', 'god': '公園阿伯' };
        return names[diff];
    }

    handleTileClick(index, isManual = false) {
        if (this.isGameOver) return;

        // 如果處於等待撤退選擇狀態
        if (this.isWaitingForRetreat && isManual) {
            if (this.retreatData && this.retreatData.options.includes(index)) {
                this.executeRetreat(index);
                this.endTurn();
            } else {
                this.showToast('請選擇發綠光的安全格子進行撤退！');
            }
            return;
        }

        // 如果是玩家手動點擊，且目前是 AI 回合，則攔截
        // 在沙盒載入的遊戲中，AI 永遠是 aiSide
        if (isManual && (this.isWaitingForAI || (this.gameMode === 'pve' && this.turn === this.aiSide))) {
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
            const moveResult = this.tryMove(this.selectedTile, index);
            if (moveResult === true) {
                this.endTurn();
            } else if (moveResult === 'pending') {
                // 等待玩家選擇撤退，不結束回合
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
        const piece = this.board[index];
        piece.isFlipped = true;
        this.addLog('flip', { pieceName: piece.type, index: index });

        // 動態先手決定
        if (this.turn === 'none') {
            this.turn = piece.side; // 當前翻棋回合算作此顏色的回合，endTurn 時會切換給對手
            if (this.gameMode === 'pve') {
                this.playerSide = piece.side; // 玩家使用翻出的顏色
            }
            this.showToast(`先手確定！玩家為 ${piece.side === 'red' ? '紅方' : '黑方'}`);
        }

        this.stateHistory = []; // 翻棋後重置狀態紀錄 (無法重複)
        this.chaseHistory = { red: [], black: [] }; // 翻棋後重置追逐紀錄
        this.renderBoard();
        this.playSound('flip');
    }

    tryMove(from, to) {
        const piece = this.board[from];
        const target = this.board[to];

        // 基本規則檢查
        if (!this.isValidTarget(from, to)) return false;

        // 禁手規則：同樣棋盤狀態不得出現 3 次
        if (this.checkRepetition(from, to)) {
            this.showRepetitionWarning('同樣的盤面已連續出現 3 次！<br>不可再重複此棋步，請改走其他棋路。');
            return false;
        }

        // 禁手規則 2：長追限制
        if (this.checkLongChase(from, to)) {
            this.showRepetitionWarning('長追警告：不可連續追逐同一棋子超過 3 次！');
            return false;
        }

        if (!target) {
            // 移動到空格
            if (this.canMoveToEmpty(from, to)) {
                this.movePiece(from, to);
                return true;
            }
        } else {
            // 吃子嘗試
            if (this.canCapture(from, to)) {
                const capResult = this.capturePiece(from, to);
                return capResult === 'pending' ? 'pending' : true;
            }
        }

        return false;
    }

    // 取得當前盤面的字串特徵，用於禁手判定
    hashBoard() {
        return this.board.map(p => p ? `${p.side[0]}${p.type}${p.isFlipped ? 1 : 0}` : '0').join('');
    }

    // 禁手：模擬移動後檢查是否重複 3 次
    checkRepetition(from, to) {
        // 先暫存被覆蓋的格子
        const tempTo = this.board[to];
        const tempFrom = this.board[from];

        // 模擬執行移動或吃子
        this.board[to] = this.board[from];
        this.board[from] = null;

        const nextStateHash = this.hashBoard();

        // 還原盤面
        this.board[from] = tempFrom;
        this.board[to] = tempTo;

        // 計算歷史中有幾次這個盤面
        const count = this.stateHistory.filter(h => h === nextStateHash).length;
        return count >= 2; // 如果之前已經出現 2 次，這次走下去就是第 3 次，所以禁止
    }

    // 禁手：顯示警告彈窗
    showRepetitionWarning(msg) {
        const modal = document.getElementById('repetition-modal');
        document.getElementById('repetition-msg').innerHTML = msg;
        modal.classList.remove('hidden');
        // 重置動畫
        const content = modal.querySelector('.modal-content');
        content.style.animation = 'none';
        requestAnimationFrame(() => {
            content.style.animation = '';
        });
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

        // 兵/卒的埋伏(夾擊)吃子
        if (piece.type === '兵' && (dr + dc === 1) && !this.compareRank(piece, target)) {
            if (this.checkAmbush(to, piece.side)) return true;
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
            { r: r - 1, c: c }, { r: r + 1, c: c }, { r: r, c: c - 1 }, { r: r, c: c + 1 }
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

    // 更新追逐歷史
    updateChaseHistory(side, moveFrom, moveTo) {
        const piece = this.board[moveTo];
        if (!piece) {
            this.chaseHistory[side] = [];
            return;
        }

        const threats = this.getThreatenedPieceIds(moveTo);
        if (threats.length > 0) {
            // 記錄「誰」在追「誰」
            // 為了簡化，若威脅多個，只記錄第一個
            this.chaseHistory[side].push(`${piece.id}->${threats[0]}`);
            // 只保留最近 5 次紀錄即可
            if (this.chaseHistory[side].length > 5) this.chaseHistory[side].shift();
        } else {
            this.chaseHistory[side] = [];
        }
    }

    checkLongChase(from, to) {
        const piece = this.board[from];
        const side = piece.side;

        // 模擬移動
        const tempTo = this.board[to];
        this.board[to] = piece;
        this.board[from] = null;
        const threats = this.getThreatenedPieceIds(to);
        this.board[from] = piece;
        this.board[to] = tempTo;

        if (threats.length === 0) return false;

        const history = this.chaseHistory[side];
        for (const victimId of threats) {
            let consecutive = 0;
            const currentPair = `${piece.id}->${victimId}`;
            for (let i = history.length - 1; i >= 0; i--) {
                if (history[i] === currentPair) consecutive++;
                else break;
            }
            if (consecutive >= 2) return true; // 已經追了 2 次，這次是第 3 次
        }
        return false;
    }

    getThreatenedPieceIds(index) {
        const piece = this.board[index];
        const threats = [];
        for (let i = 0; i < 32; i++) {
            const target = this.board[i];
            if (target && target.isFlipped && target.side !== piece.side) {
                if (this.canCapture(index, i)) threats.push(target.id);
            }
        }
        return threats;
    }

    movePiece(from, to) {
        this.saveHistory();
        const piece = this.board[from];
        // 如果使用了特殊移動 (如帥的對角線)，進入冷卻
        const { r: r1, c: c1 } = this.getRC(from);
        const { r: r2, c: c2 } = this.getRC(to);
        if (piece.isUpgraded && piece.type === '帥' && Math.abs(r1 - r2) === 1 && Math.abs(c1 - c2) === 1) {
            piece.cooldown = 2; // 設定冷卻 2 (因為 endTurn 會立刻減 1)
        }
        this.addLog('move', { pieceName: piece.type, from: from, to: to });

        this.board[to] = this.board[from];
        this.board[from] = null;
        this.deselect();

        this.lastMovedTo = to;
        this.stateHistory.push(this.hashBoard());
        this.updateChaseHistory(piece.side, from, to);

        this.renderBoard();
        this.playSound('move');
    }

    capturePiece(from, to) {
        this.saveHistory();
        const attacker = this.board[from];
        const victim = this.board[to];

        // 先記錄升級前的狀態，避免 executeCapture 升級後誤觸重踏
        const wasAlreadyUpgraded = attacker.isUpgraded;
        const isSpecialMove = this.isSpecialMove(from, to);

        // 兵/卒的撤退防禦：連續攻擊判定
        if (victim.type === '兵' && victim.isUpgraded) {
            // 如果這回合距離上一次被打已經超過 2 個回合 (也就是經過了一整圈沒被打)，重置生命
            if (victim.retreatHitTurn !== -1 && (this.turnCount - victim.retreatHitTurn > 2)) {
                victim.retreatHitTurn = -1; // 喘息成功，滿血
            }

            if (victim.retreatHitTurn === -1) {
                // 第一次被打，觸發撤退
                const retreatResult = this.handleInteractiveSoldierRetreat(from, to);
                if (retreatResult === 'pending') {
                    if (wasAlreadyUpgraded && isSpecialMove) attacker.cooldown = 2;
                    return 'pending'; // 暫停回合等待選擇
                } else if (retreatResult === 'done') {
                    if (wasAlreadyUpgraded && isSpecialMove) attacker.cooldown = 2;
                    return 'done'; // AI 瞬間撤退完畢
                }
                // 若回傳 'killed' 代表無路可退，繼續執行底下的吃子
            }
            // 若 retreatHitTurn !== -1 代表連續被打，直接執行底下的吃子
        }

        // 執行吃子
        this.executeCapture(from, to);
        if (wasAlreadyUpgraded && isSpecialMove) attacker.cooldown = 2;

        this.updateChaseHistory(attacker.side, from, to);

        // 相/象的重踏技能：必須是吃子前就已升級才能觸發
        if (wasAlreadyUpgraded && attacker.type === '相' && attacker.cooldown === 0) {
            this.handleElephantTrample(from, to);
            attacker.cooldown = 2; // 重踏也是特殊技能
        }
        return 'done';
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
        this.addLog('capture', { attackerName: attacker.type, victimName: victim.type, from: from, to: to });

        if (!attacker.isUpgraded) {
            attacker.isUpgraded = true;
            this.playSound('upgrade');
        }

        this.captured[attacker.side].push(victim);
        this.updateGraveyard();

        this.board[to] = attacker;
        this.board[from] = null;

        this.deselect();

        this.stateHistory = []; // 吃子後無法復原狀態，清空歷史
        this.lastMovedTo = to;

        this.renderBoard();
        this.playSound('capture');
        this.checkWin();
    }

    handleInteractiveSoldierRetreat(from, index) {
        const attacker = this.board[from];
        const victim = this.board[index];
        const { r, c } = this.getRC(index);
        const neighbors = [
            { r: r - 1, c: c }, { r: r + 1, c: c }, { r: r, c: c - 1 }, { r: r, c: c + 1 }
        ];

        // 找出可撤退的空格 (包含攻擊方目前的位置，因為他等下會進來)
        const emptySlots = neighbors.filter(n => {
            if (n.r < 0 || n.r >= BOARD_ROWS || n.c < 0 || n.c >= BOARD_COLS) return false;
            const nIdx = n.r * BOARD_COLS + n.c;
            return this.board[nIdx] === null || nIdx === from;
        }).map(n => n.r * BOARD_COLS + n.c);

        victim.retreatHitTurn = this.turnCount; // 記錄這次受傷的回合

        if (emptySlots.length > 0) {
            // 判斷是否由玩家手動操作
            const isInteractive = (this.gameMode === 'pvp' || victim.side === this.playerSide);

            if (isInteractive) {
                this.isWaitingForRetreat = true;
                this.retreatData = { attacker: from, victim: index, options: emptySlots };
                this.showToast('兵卒觸發【撤退】！請點擊發綠光的安全格子避難！');
                this.renderBoard();
                return 'pending'; // 暫停回合
            } else {
                // AI 遭到攻擊，自動隨機選擇一個安全的退路
                const escapeIdx = emptySlots[Math.floor(Math.random() * emptySlots.length)];
                this.executeRetreat(escapeIdx, from, index);
                return 'done'; // 自動完成
            }
        } else {
            return 'killed'; // 無路可退
        }
    }

    executeRetreat(targetIdx, fallbackAttacker = null, fallbackVictim = null) {
        const attackerIdx = fallbackAttacker !== null ? fallbackAttacker : this.retreatData.attacker;
        const victimIdx = fallbackVictim !== null ? fallbackVictim : this.retreatData.victim;

        const attacker = this.board[attackerIdx];
        const victim = this.board[victimIdx];
        this.addLog('retreat', { pieceName: victim.type, to: targetIdx });

        // 1. 兵後退到逃脫格
        this.board[targetIdx] = victim;

        // 2. 攻擊方補位
        this.board[victimIdx] = attacker;
        this.board[attackerIdx] = null;

        this.isWaitingForRetreat = false;
        this.retreatData = null;

        this.lastMovedTo = victimIdx;
        this.stateHistory.push(this.hashBoard());
        this.updateChaseHistory(victim.side, victimIdx, targetIdx); // 兵卒撤退後的反擊潛力（雖然少見但需更新歷史）

        this.playSound('move');
        this.renderBoard();
    }

    // 輕量提示 (取代 alert，不阻塞遊戲)
    showToast(msg) {
        let toast = document.getElementById('game-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'game-toast';
            toast.style.cssText = `
                position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
                background: rgba(0,0,0,0.85); color: #ffd700; padding: 12px 24px;
                border-radius: 12px; font-size: 1rem; font-weight: 600;
                border: 1px solid rgba(255,215,0,0.4); z-index: 200;
                pointer-events: none; transition: opacity 0.3s ease;
            `;
            document.body.appendChild(toast);
        }
        toast.innerText = msg;
        toast.style.opacity = '1';
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
    }

    handleElephantTrample(from, to) {
        const { r, c } = this.getRC(to);
        const attacker = this.board[to];
        if (!attacker) return;
        
        let trampleCount = 0;

        // 檢查周圍 8 格 (相鄰所有方向)
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                const tr = r + dr;
                const tc = c + dc;

                if (tr >= 0 && tr < BOARD_ROWS && tc >= 0 && tc < BOARD_COLS) {
                    const trIdx = tr * BOARD_COLS + tc;
                    const extraVictim = this.board[trIdx];
                    
                    // 必須是已翻開的敵對棋子，且等級低於 相 (5)
                    if (extraVictim && extraVictim.isFlipped && extraVictim.side !== attacker.side) {
                        if (PIECE_TYPES[extraVictim.type].value < PIECE_TYPES['相'].value) {
                            this.captured[attacker.side].push(extraVictim);
                            this.board[trIdx] = null;
                            this.addLog('capture', { attackerName: '相(重踏)', victimName: extraVictim.type, from: to, to: trIdx });
                            trampleCount++;
                        }
                    }
                }
            }
        }

        if (trampleCount > 0) {
            this.playSound('capture');
            this.showToast(`相觸發【重踏】：連帶震碎周圍 ${trampleCount} 顆棋子！`);
            this.renderBoard();
            this.checkWin();
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

        if (this.turn === 'none') {
            indicator.className = 'turn-none';
            text.innerText = '請翻開第一顆棋子';
        } else {
            indicator.className = this.turn === 'red' ? 'turn-red' : 'turn-black';
            text.innerText = this.turn === 'red' ? '紅方回合' : '黑方回合';
        }
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

    get aiSide() {
        if (this.playerSide) return this.playerSide === 'red' ? 'black' : 'red';
        return 'black';
    }

    endTurn() {
        this.turnCount++; // 增加回合數

        // 更新所有棋子的冷卻時間 (目前回合方的棋子減冷卻)
        this.board.forEach(p => {
            if (p && p.side === this.turn && p.cooldown > 0) {
                p.cooldown--;
            }
        });

        this.turn = this.turn === 'red' ? 'black' : 'red';
        this.updateStatus();
        this.renderBoard(); // 重新渲染以更新冷卻視覺與發光提示

        if (this.gameMode === 'pve' && this.turn === this.aiSide && !this.isGameOver) {
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
            this.addLog('win', { winner: 'black' });
        } else if (blackLeft === 0) {
            alert('紅方勝利！');
            this.isGameOver = true;
            this.addLog('win', { winner: 'red' });
        }
    }

    // ===== 音效系統 (手機修復版) =====
    // 使用單一持久 AudioContext，解決 iOS/Android 限制每頁面 AudioContext 數量的問題
    getAudioContext() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        // 手機端：瀏覽器可能在背景時 suspend AudioContext，需主動 resume
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
        return this.audioContext;
    }

    resumeAudioContext() {
        // 在使用者互動時觸發，確保 AudioContext 已啟動 (iOS 強制要求)
        const ctx = this.getAudioContext();
        if (ctx.state === 'suspended') ctx.resume();
    }

    playSound(type) {
        try {
            const ctx = this.getAudioContext();
            if (ctx.state === 'suspended') return; // 還未被使用者互動解鎖，靜默跳過

            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.connect(gain);
            gain.connect(ctx.destination);

            const now = ctx.currentTime;

            switch (type) {
                case 'flip':
                    osc.frequency.setValueAtTime(400, now);
                    osc.frequency.exponentialRampToValueAtTime(600, now + 0.1);
                    gain.gain.setValueAtTime(0.1, now);
                    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
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
                case 'select':
                    osc.frequency.setValueAtTime(500, now);
                    gain.gain.setValueAtTime(0.03, now);
                    gain.gain.linearRampToValueAtTime(0, now + 0.08);
                    osc.start(now);
                    osc.stop(now + 0.08);
                    break;
            }
        } catch (e) {
            // 音效失敗時靜默降級，不影響遊戲
            console.warn('Sound playback failed:', e);
        }
    }

    makeAIMove() {
        if (this.isGameOver) return;

        try {
            let bestMove = null;

            switch (this.aiDifficulty) {
                case 'novice':
                    bestMove = this.getRandomMove();
                    break;
                case 'amateur':
                    bestMove = this.getSmartMove(2);
                    break;
                case 'pro':
                    bestMove = this.getSmartMove(4);
                    break;
                case 'god':
                    bestMove = this.getSmartMove(5);
                    break;
            }

            if (bestMove) {
                if (bestMove.type === 'flip') {
                    this.handleTileClick(bestMove.index);
                } else {
                    this.handleTileClick(bestMove.from);
                    setTimeout(() => this.handleTileClick(bestMove.to), 400);
                }
            } else {
                console.warn('AI 找不到任何走法！');
            }
        } catch (error) {
            console.error('AI Error:', error);
            alert('AI 發生錯誤: ' + error.message + '\n' + error.stack);
            this.isWaitingForAI = false; // 解除鎖定，讓玩家可以繼續操作
        }
    }

    getRandomMove() {
        const moves = this.getAllValidMoves(this.aiSide);
        const unflipped = this.getUnflippedIndices();
        // 新手也會優先吃子
        const captures = moves.filter(m => this.board[m.to] !== null);
        if (captures.length > 0 && Math.random() > 0.4) {
            return { type: 'move', ...captures[Math.floor(Math.random() * captures.length)] };
        }
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

    getSmartMove(depth) {
        let bestScore = -Infinity;
        let bestMove = null;

        const moves = this.getAllValidMoves(this.aiSide);
        const unflipped = this.getUnflippedIndices();

        // 如果完全沒棋可走，必翻棋
        if (moves.length === 0 && unflipped.length > 0) {
            return { type: 'flip', index: unflipped[Math.floor(Math.random() * unflipped.length)] };
        }

        // 走法排序：優先評估吃子走法，提高 alpha-beta 剪枝效率
        const sortedMoves = this.orderMoves(moves, this.aiSide);

        // 評估所有走法
        for (const move of sortedMoves) {
            const captured = this.simulateCapture(move.from, move.to);
            let score = this.minimax(depth - 1, -Infinity, Infinity, false);
            this.undoSimulateCapture(move.from, move.to, captured);

            if (score > bestScore) {
                bestScore = score;
                bestMove = { type: 'move', ...move };
            }
        }

        // 翻棋決策 (更聰明)
        if (unflipped.length > 0) {
            // 計算我方已翻開棋子數
            const myFlipped = this.board.filter(p => p && p.side === this.aiSide && p.isFlipped).length;
            const enemyFlipped = this.board.filter(p => p && p.side === this.playerSide && p.isFlipped).length;

            // 情況1：沒有找到任何移動
            if (!bestMove) {
                return { type: 'flip', index: unflipped[Math.floor(Math.random() * unflipped.length)] };
            }

            // 情況2：我方場上棋子太少，需要翻更多出來
            if (myFlipped <= 2 && unflipped.length > 0) {
                return { type: 'flip', index: unflipped[Math.floor(Math.random() * unflipped.length)] };
            }

            // 情況3：目前最佳走法評分很低（被動局面），試試翻棋
            const flipThreshold = -50;
            if (bestScore < flipThreshold && unflipped.length >= 4) {
                return { type: 'flip', index: unflipped[Math.floor(Math.random() * unflipped.length)] };
            }
        }

        // 保底
        if (!bestMove) {
            if (unflipped.length > 0) return { type: 'flip', index: unflipped[0] };
            if (moves.length > 0) return { type: 'move', ...moves[0] };
        }

        return bestMove;
    }

    // 走法排序：吃子 > 威脅 > 普通移動，大幅提升剪枝效率
    orderMoves(moves, side) {
        return moves.map(m => {
            let priority = 0;
            const target = this.board[m.to];
            const attacker = this.board[m.from];
            if (target) {
                // 吃子走法：用 MVV-LVA (Most Valuable Victim - Least Valuable Attacker)
                priority = 1000 + PIECE_TYPES[target.type].value * 100 - PIECE_TYPES[attacker.type].value * 10;
            } else {
                // 移動到安全位置加分
                if (!this.isPieceUnderThreatAt(m.to, side)) priority += 20;
                // 移動到中心加分
                const { r, c } = this.getRC(m.to);
                priority += 10 - Math.abs(r - 3.5) - Math.abs(c - 1.5);
            }
            return { ...m, priority };
        }).sort((a, b) => b.priority - a.priority);
    }

    minimax(depth, alpha, beta, isMaximizing) {
        if (depth === 0) {
            return this.evaluateBoard();
        }

        const side = isMaximizing ? this.aiSide : this.playerSide;
        const moves = this.getAllValidMoves(side);

        // 無棋可走 = 極端劣勢
        if (moves.length === 0) {
            const myPieces = this.board.filter(p => p && p.side === side && p.isFlipped).length;
            return isMaximizing ? (myPieces === 0 ? -99999 : this.evaluateBoard()) : (myPieces === 0 ? 99999 : this.evaluateBoard());
        }

        // 走法排序
        const sortedMoves = this.orderMoves(moves, side);

        if (isMaximizing) {
            let maxEval = -Infinity;
            for (let move of sortedMoves) {
                const captured = this.simulateCapture(move.from, move.to);
                let evaluation = this.minimax(depth - 1, alpha, beta, false);
                this.undoSimulateCapture(move.from, move.to, captured);
                maxEval = Math.max(maxEval, evaluation);
                alpha = Math.max(alpha, evaluation);
                if (beta <= alpha) break;
            }
            return maxEval;
        } else {
            let minEval = Infinity;
            for (let move of sortedMoves) {
                const captured = this.simulateCapture(move.from, move.to);
                let evaluation = this.minimax(depth - 1, alpha, beta, true);
                this.undoSimulateCapture(move.from, move.to, captured);
                minEval = Math.min(minEval, evaluation);
                beta = Math.min(beta, evaluation);
                if (beta <= alpha) break;
            }
            return minEval;
        }
    }

    evaluateBoard() {
        let score = 0;
        let aiMobility = 0;
        let playerMobility = 0;
        let aiPieceCount = 0;
        let playerPieceCount = 0;

        this.board.forEach((p, i) => {
            if (!p) return;
            if (!p.isFlipped) {
                score += (p.side === this.aiSide ? 2 : -2);
                return;
            }

            const side = p.side;
            if (side === this.aiSide) aiPieceCount++; else playerPieceCount++;

            // === 基礎棋子價值 (使用更大的差距) ===
            let val = PIECE_TYPES[p.type].value * 50;

            // === 升級加成 ===
            if (p.isUpgraded) {
                val += 40;
                if (p.cooldown === 0) val += 15; // 技能可用更值錢
            }

            // === 兵的撤退防禦加成 ===
            if (p.type === '兵' && p.isUpgraded && p.retreatHitTurn === -1) val += 20;

            // === 位置評估 ===
            const { r, c } = this.getRC(i);
            // 中心控制
            const distFromCenter = Math.abs(r - 3.5) + Math.abs(c - 1.5);
            val += (8 - distFromCenter * 1.5);

            // 邊角懲罰（棋子容易被困）
            if (c === 0 || c === BOARD_COLS - 1) val -= 3;
            if (r === 0 || r === BOARD_ROWS - 1) val -= 2;

            // === 安全性評估 ===
            const underThreat = this.isPieceUnderThreatAt(i, side);
            const isProtected = this.isPieceProtected(i, side);

            if (underThreat) {
                if (isProtected) {
                    // 被威脅但有保護：小幅減分
                    val -= PIECE_TYPES[p.type].value * 8;
                } else {
                    // 被威脅且無保護：大幅減分
                    val -= PIECE_TYPES[p.type].value * 25;
                }
            }

            if (isProtected && !underThreat) {
                val += 5; // 安全且有保護加分
            }

            // === 機動性（能走多少步）===
            let mobility = 0;
            for (let j = 0; j < 32; j++) {
                if (this.tryMovePreview(i, j)) mobility++;
            }
            val += mobility * 3;
            if (side === this.aiSide) aiMobility += mobility;
            else playerMobility += mobility;

            // === 帥/將特殊評估：安全最重要 ===
            if (p.type === '帥') {
                if (underThreat) val -= 200; // 將帥被威脅是災難
                // 周圍友軍越多越安全
                const { r: kr, c: kc } = this.getRC(i);
                let guardsNearby = 0;
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        if (dr === 0 && dc === 0) continue;
                        const nr = kr + dr, nc = kc + dc;
                        if (nr >= 0 && nr < BOARD_ROWS && nc >= 0 && nc < BOARD_COLS) {
                            const g = this.board[nr * BOARD_COLS + nc];
                            if (g && g.side === side && g.isFlipped) guardsNearby++;
                        }
                    }
                }
                val += guardsNearby * 8;
            }

            // === 兵卒夾擊潛力 ===
            if (p.type === '兵') {
                const { r: sr, c: sc } = this.getRC(i);
                const dirs = [{ r: sr - 1, c: sc }, { r: sr + 1, c: sc }, { r: sr, c: sc - 1 }, { r: sr, c: sc + 1 }];
                let friendlySoldiersNearby = 0;
                dirs.forEach(d => {
                    if (d.r >= 0 && d.r < BOARD_ROWS && d.c >= 0 && d.c < BOARD_COLS) {
                        const nb = this.board[d.r * BOARD_COLS + d.c];
                        if (nb && nb.side === side && nb.type === '兵' && nb.isFlipped) {
                            friendlySoldiersNearby++;
                        }
                    }
                });
                if (friendlySoldiersNearby >= 1) val += 15; // 兵靠近有夾擊潛力
            }

            score += (side === this.aiSide ? val : -val);
        });

        // === 全局機動性差值 ===
        score += (aiMobility - playerMobility) * 2;

        // === 棋子數差值加成 ===
        score += (aiPieceCount - playerPieceCount) * 15;

        return score;
    }

    // 檢查某格的棋子是否被威脅
    isPieceUnderThreatAt(index, side) {
        const enemySide = side === 'red' ? 'black' : 'red';
        for (let i = 0; i < 32; i++) {
            const p = this.board[i];
            if (p && p.side === enemySide && p.isFlipped) {
                if (this.tryMovePreview(i, index)) return true;
            }
        }
        return false;
    }

    isPieceUnderThreat(index, side) {
        return this.isPieceUnderThreatAt(index, side);
    }

    // 檢查某格的棋子是否有友軍保護（如果被吃，友軍能反吃）
    isPieceProtected(index, side) {
        const { r, c } = this.getRC(index);
        const dirs = [{ r: r - 1, c: c }, { r: r + 1, c: c }, { r: r, c: c - 1 }, { r: r, c: c + 1 }];
        for (const d of dirs) {
            if (d.r >= 0 && d.r < BOARD_ROWS && d.c >= 0 && d.c < BOARD_COLS) {
                const idx = d.r * BOARD_COLS + d.c;
                const p = this.board[idx];
                if (p && p.side === side && p.isFlipped && idx !== index) {
                    return true;
                }
            }
        }
        return false;
    }

    // 模擬吃子（回傳被吃掉的棋子以便還原）
    simulateCapture(from, to) {
        const captured = this.board[to];
        this.board[to] = this.board[from];
        this.board[from] = null;
        return captured;
    }

    // 還原模擬吃子
    undoSimulateCapture(from, to, captured) {
        this.board[from] = this.board[to];
        this.board[to] = captured;
    }

    // 走法生成
    getAllValidMoves(side) {
        const moves = [];
        this.board.forEach((p, i) => {
            if (p && p.side === side && p.isFlipped) {
                for (let j = 0; j < 32; j++) {
                    if (this.tryMovePreview(i, j)) {
                        // AI 走法生成時，必須排除會觸發禁手的棋步
                        if (!this.checkRepetition(i, j)) {
                            moves.push({ from: i, to: j });
                        }
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
            { type: '相', skill: '重踏', desc: '吃子後，連帶震碎目標周圍相鄰的低階已翻開敵棋。', demo: 'trample' },
            { type: '俥', skill: '衝鋒', desc: '直線衝刺越級吃子，不可用於單純移動。', demo: 'rush' },
            { type: '傌', skill: '凌空', desc: '跳過相鄰的一顆棋子越級吃子，不可用於單純移動。', demo: 'leap' },
            { type: '砲', skill: '神砲', desc: '可一次飛越多顆棋子進行遠程打擊。', demo: 'supercannon' },
            { type: '兵', skill: '撤退/埋伏', desc: '升級後可撤退一次（需連續攻擊兩次才能擊殺）；兩隻兵夾擊敵棋可越級吃子。', demo: 'ambush' }
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
        for (let i = 0; i < 9; i++) html += `<div class="demo-tile"></div>`;
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
            // 清理上一次循環可能留下的額外棋子
            board.querySelectorAll('.demo-piece-extra').forEach(p => p.remove());

            // 重置位置
            if (demoType === 'diagonal') {
                this.setDemoPos(attacker, tiles[8]);
                this.setDemoPos(victim, tiles[4]);
                setTimeout(() => this.setDemoPos(attacker, tiles[4]), 1000);
            } else if (demoType === 'leap') {
                const hurdle = document.createElement('div');
                hurdle.className = 'demo-piece black demo-piece-extra'; hurdle.innerText = '兵';
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
            } else if (demoType === 'trample') {
                const victim2 = document.createElement('div');
                victim2.className = 'demo-piece black demo-piece-extra'; victim2.innerText = '兵';
                board.appendChild(victim2);
                this.setDemoPos(attacker, tiles[8]);
                this.setDemoPos(victim, tiles[7]);
                this.setDemoPos(victim2, tiles[4]);
                setTimeout(() => {
                    this.setDemoPos(attacker, tiles[7]);
                    victim.style.opacity = '0';
                    victim2.style.opacity = '0';
                    // 震動效果
                    board.style.animation = 'none';
                    requestAnimationFrame(() => board.style.animation = 'shake 0.3s');
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

    // ===== 沙盒模式 =====
    initSandbox() {
        this.sandboxBoard = new Array(32).fill(null);
        this.selectedPieceDef = null;
        this.sandboxEraseMode = false;
        this.renderPalette();
        this.renderSandboxBoard();
        this.setupSandboxEvents();
    }

    renderPalette() {
        const allPieces = [
            { type: '帥', side: 'red', char: '帥' },
            { type: '仕', side: 'red', char: '仕' },
            { type: '相', side: 'red', char: '相' },
            { type: '俥', side: 'red', char: '俥' },
            { type: '傌', side: 'red', char: '傌' },
            { type: '砲', side: 'red', char: '砲' },
            { type: '兵', side: 'red', char: '兵' },
            { type: '帥', side: 'black', char: '將' },
            { type: '仕', side: 'black', char: '士' },
            { type: '相', side: 'black', char: '象' },
            { type: '俥', side: 'black', char: '車' },
            { type: '傌', side: 'black', char: '馬' },
            { type: '砲', side: 'black', char: '炮' },
            { type: '兵', side: 'black', char: '卒' },
        ];

        ['red', 'black'].forEach(side => {
            const container = document.getElementById(`${side}-palette`);
            container.innerHTML = '';
            allPieces.filter(p => p.side === side).forEach(p => {
                const btn = document.createElement('div');
                btn.className = `palette-piece ${p.side}`;
                btn.dataset.type = p.type;
                btn.dataset.side = p.side;
                btn.dataset.char = p.char;
                btn.innerText = p.char;
                btn.addEventListener('click', () => {
                    document.querySelectorAll('.palette-piece').forEach(el => el.classList.remove('palette-selected'));
                    document.getElementById('palette-eraser').classList.remove('active');
                    this.sandboxEraseMode = false;
                    this.selectedPieceDef = { type: p.type, side: p.side, char: p.char };
                    btn.classList.add('palette-selected');
                });
                container.appendChild(btn);
            });
        });
    }

    renderSandboxBoard() {
        const boardEl = document.getElementById('sandbox-board');
        boardEl.innerHTML = '';
        this.sandboxBoard.forEach((piece, index) => {
            const tile = document.createElement('div');
            tile.className = 'tile';
            tile.dataset.index = index;
            if (piece) {
                const pieceEl = document.createElement('div');
                pieceEl.className = `piece ${piece.side} flipped ${piece.isUpgraded ? 'upgraded' : ''}`;
                const front = document.createElement('div');
                front.className = 'piece-face piece-front';
                front.innerText = piece.char + (piece.isUpgraded ? ' ✨' : '');
                const back = document.createElement('div');
                back.className = 'piece-face piece-back';
                pieceEl.appendChild(front);
                pieceEl.appendChild(back);
                tile.appendChild(pieceEl);
            }
            boardEl.appendChild(tile);
        });
    }

    setupSandboxEvents() {
        const boardEl = document.getElementById('sandbox-board');
        boardEl.onclick = (e) => {
            const tile = e.target.closest('.tile');
            if (!tile) return;
            this.handleSandboxClick(parseInt(tile.dataset.index));
        };
        boardEl.oncontextmenu = (e) => {
            e.preventDefault();
            const tile = e.target.closest('.tile');
            if (!tile) return;
            const idx = parseInt(tile.dataset.index);
            if (this.sandboxBoard[idx]) {
                this.sandboxBoard[idx].isUpgraded = !this.sandboxBoard[idx].isUpgraded;
                this.renderSandboxBoard();
                this.showToast(this.sandboxBoard[idx].isUpgraded ? '已設為升級狀態 ✨' : '已取消升級狀態');
            }
        };
        document.getElementById('palette-eraser').onclick = () => {
            document.querySelectorAll('.palette-piece').forEach(el => el.classList.remove('palette-selected'));
            this.selectedPieceDef = null;
            this.sandboxEraseMode = true;
            document.getElementById('palette-eraser').classList.add('active');
        };
    }

    handleSandboxClick(idx) {
        if (this.sandboxEraseMode) {
            this.sandboxBoard[idx] = null;
            this.renderSandboxBoard();
            return;
        }
        if (!this.selectedPieceDef) {
            this.showToast('請先從左方選板選擇一樣棋子');
            return;
        }
        // 再點同一棋子則移除，否則放置
        const existing = this.sandboxBoard[idx];
        if (existing && existing.type === this.selectedPieceDef.type && existing.side === this.selectedPieceDef.side) {
            this.sandboxBoard[idx] = null;
        } else {
            this.sandboxBoard[idx] = {
                type: this.selectedPieceDef.type,
                side: this.selectedPieceDef.side,
                char: this.selectedPieceDef.char,
                isFlipped: true,
                isUpgraded: false,
                cooldown: 0,
                retreatHitTurn: -1, // 修復：初始化受傷紀錄，否則會直接死亡
                livesLeft: this.selectedPieceDef.type === '兵' ? 1 : 0
            };
        }
        this.renderSandboxBoard();
    }

    // ===== 對局紀錄系統 =====
    getCoord(index) {
        const { r, c } = this.getRC(index);
        return `(${r},${c})`;
    }

    addLog(action, details = {}) {
        const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
        let turnText = this.turn === 'red' ? '🔴紅方' : (this.turn === 'black' ? '⚫黑方' : '⚙️系統');
        let msg = `[${time}] ${turnText}: `;

        switch (action) {
            case 'start':
                msg = `[${time}] 🎮 遊戲開始 - 模式: ${this.gameMode}, 難度: ${this.getDiffName(this.aiDifficulty)}`;
                this.gameLogs = [msg];
                break;
            case 'flip':
                msg += `翻開棋子 ${details.pieceName} 於 ${this.getCoord(details.index)}`;
                break;
            case 'move':
                msg += `將 ${details.pieceName} 從 ${this.getCoord(details.from)} 移動到 ${this.getCoord(details.to)}`;
                break;
            case 'capture':
                msg += `以 ${details.attackerName} 吃掉 ${details.victimName} (${this.getCoord(details.from)} -> ${this.getCoord(details.to)})`;
                break;
            case 'retreat':
                msg += `${details.pieceName} 撤退到 ${this.getCoord(details.to)}`;
                break;
            case 'undo':
                msg = `[${time}] ⏪ [悔棋] 撤回上一手`;
                break;
            case 'win':
                msg = `[${time}] 🏆 遊戲結束 - ${details.winner === 'red' ? '紅方' : '黑方'} 勝利！`;
                break;
            default:
                return;
        }
        this.gameLogs.push(msg);
        console.log(msg);
    }

    initExportListener() {
        const btn = document.getElementById('export-log-btn');
        if (btn) {
            btn.onclick = () => this.exportGameLog();
        }
    }

    exportGameLog() {
        if (this.gameLogs.length === 0) {
            this.showToast ? this.showToast('尚無紀錄可匯出') : alert('尚無紀錄可匯出');
            return;
        }
        const content = this.gameLogs.join('\r\n');
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const now = new Date();
        const filename = `DarkChess_Log_${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}.txt`;
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

window.onload = () => new Game();
