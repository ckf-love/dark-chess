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

// AI 思考逾時的中斷信號（搭配迭代加深，時間到立刻回傳當前最佳解）
const AI_TIMEOUT = 'AI_THINK_TIMEOUT';

/**
 * AI 難度設定表
 * depth        : 主搜尋深度（legend 為迭代加深的上限）
 * quiescence   : 葉節點是否進行靜態吃子搜尋（消除地平線效應）
 * see          : 是否使用靜態交換評估（SEE）判斷兌子划不划算
 * smartFlip    : 是否用「剩餘暗子期望值」評估翻棋（否則隨機翻）
 * blunderRate  : 機率性失誤（模擬人類漏招），0 = 不失誤
 * randomTemp   : 走法選擇的隨機溫度（softmax），數值越大越愛在相近走法間變化
 * flipBias     : 翻棋傾向修正（正值愛翻、負值保守），單位為評估分數
 * useTT        : 是否啟用置換表加速
 * iterative    : 是否迭代加深（搭配 maxTime 控制不卡頓）
 * maxTime      : 單步思考時間上限（毫秒），時間到立即回傳當前最佳解
 */
const AI_PROFILES = {
    novice:  { name: '3歲小童', depth: 1, quiescence: false, see: false, smartFlip: false, blunderRate: 0.55, randomTemp: 240, flipBias: 25,  useTT: false, iterative: false, maxTime: 300 },
    amateur: { name: '小學生',  depth: 2, quiescence: false, see: false, smartFlip: true,  blunderRate: 0.18, randomTemp: 90,  flipBias: 0,   useTT: false, iterative: false, maxTime: 500 },
    pro:     { name: '樓下阿嬤', depth: 3, quiescence: true,  see: true,  smartFlip: true,  blunderRate: 0.05, randomTemp: 35,  flipBias: -5,  useTT: true,  iterative: false, maxTime: 900 },
    god:     { name: '公園阿伯', depth: 4, quiescence: true,  see: true,  smartFlip: true,  blunderRate: 0.0,  randomTemp: 12,  flipBias: -10, useTT: true,  iterative: false, maxTime: 1300 },
    legend:  { name: '國士無雙', depth: 6, quiescence: true,  see: true,  smartFlip: true,  blunderRate: 0.0,  randomTemp: 0,   flipBias: -15, useTT: true,  iterative: true,  maxTime: 1800 },
};

/* =========================================================================
 * 測試碼 / 設備綁定系統設定
 * -------------------------------------------------------------------------
 * 遊戲檔案放在 GitHub，碼與綁定紀錄放在 Supabase 免費資料庫。
 * 下面兩個值請填入你的 Supabase 專案資訊：
 *   Supabase 後台 → Project Settings → API
 *     - Project URL        → 填 SUPABASE_URL
 *     - Project API keys 的 anon public → 填 SUPABASE_ANON_KEY
 * anon key 可以公開（安全性由資料庫的 RLS + 函式把關，碼不會外洩）。
 * ========================================================================= */
const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co'; // ← 換成你的 Project URL
const SUPABASE_ANON_KEY = 'YOUR_ANON_PUBLIC_KEY';           // ← 換成你的 anon public key

// 是否已正確填入設定（未填時讓開發中可繞過，避免本機完全進不去）
function isGateConfigured() {
    return SUPABASE_URL.indexOf('YOUR_PROJECT_ID') === -1 &&
           SUPABASE_ANON_KEY.indexOf('YOUR_ANON') === -1 &&
           SUPABASE_URL.startsWith('http');
}

// 取得 / 產生這台設備的唯一識別碼（存在本機 localStorage）
function getDeviceId() {
    let id = null;
    try { id = localStorage.getItem('dc_device_id'); } catch (e) { /* 隱私模式可能拋錯 */ }
    if (!id) {
        if (window.crypto && crypto.randomUUID) {
            id = crypto.randomUUID();
        } else {
            id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        }
        try { localStorage.setItem('dc_device_id', id); } catch (e) { /* 忽略 */ }
    }
    return id;
}

// 呼叫 Supabase 的 RPC 函式（POST /rest/v1/rpc/<fn>）
async function callRpc(fn, params) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(params || {})
    });
    if (!res.ok) {
        throw new Error('RPC ' + fn + ' failed: ' + res.status);
    }
    return res.json();
}

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
        this.initGate();
        this.initCodesAdmin();
        this.updateStatus();
        this.runEntryCheck();
    }

    showPage(pageId) {
        const pages = ['gate-page', 'start-page', 'sandbox-page', 'codes-admin-page', 'guide-page', 'main-game'];
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

                // 根據沙盒設定決定模式
                this.gameMode = document.getElementById('sandbox-game-mode').value;
                
                this.turn = 'red';
                this.playerSide = 'red'; // 預設沙盒載入後玩家為紅方
                
                // 如果是人機模式，設定 AI 難度（預設業餘）
                if (this.gameMode === 'pve') {
                    this.aiDifficulty = 'amateur';
                }

                document.getElementById('game-mode-display').innerText =
                    this.gameMode === 'pvp' ? '人 vs 人' : `人 vs AI (${this.getDiffName(this.aiDifficulty)})`;

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
        const names = { 'novice': '3歲小童', 'amateur': '小學生', 'pro': '樓下阿嬤', 'god': '公園阿伯', 'legend': '國士無雙' };
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
        this.addLog('flip', { pieceName: piece.char, index: index });

        // 動態先手決定
        if (this.turn === 'none') {
            this.turn = piece.side; // 當前翻棋回合算作此顏色的回合，endTurn 時會切換給對手
            if (this.gameMode === 'pve') {
                this.playerSide = piece.side; // 玩家使用翻出的顏色
            }
            this.showToast(`先手確定！玩家為 ${piece.side === 'red' ? '紅方' : '黑方'}`);
        }

        this.stateHistory = []; // 翻棋後重置狀態紀錄 (無法重複)
        this.resetChaseHistory(); // 翻棋後重置追逐紀錄
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
        const chasedPieceName = this.checkLongChase(from, to);
        if (chasedPieceName) {
            this.showRepetitionWarning(`禁止重複追殺同一顆棋 (${chasedPieceName})`);
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

    resetChaseHistory() {
        this.chaseHistory = { red: [], black: [] };
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

        if (threats.length === 0) return null;

        const history = this.chaseHistory[side];
        for (const victimId of threats) {
            let consecutive = 0;
            const currentPair = `${piece.id}->${victimId}`;
            for (let i = history.length - 1; i >= 0; i--) {
                if (history[i] === currentPair) consecutive++;
                else break;
            }
            if (consecutive >= 5) {
                const victim = this.getPieceById(victimId);
                return victim ? victim.type : "棋子";
            }
        }
        return null;
    }

    getPieceById(id) {
        for (let i = 0; i < 32; i++) {
            if (this.board[i] && this.board[i].id === id) return this.board[i];
        }
        return null;
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
        this.addLog('move', { pieceName: piece.char, from: from, to: to });

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

        // 吃子屬於重大盤面變動，重置長追紀錄
        this.resetChaseHistory();
        this.updateChaseHistory(attacker.side, from, to);

        // 相/象的重踏技能：必須是吃子前就已升級才能觸發
        // 修正：確保判定獨立且在動作完成後第一時間執行
        if (wasAlreadyUpgraded && attacker.type === '相' && attacker.cooldown === 0) {
            this.handleElephantTrample(from, to);
            attacker.cooldown = 2; 
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
        this.addLog('capture', { attackerName: attacker.char, victimName: victim.char, from: from, to: to });

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
            return this.board[nIdx] === null;
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
        this.addLog('retreat', { pieceName: victim.char, to: targetIdx });

        // 1. 兵後退到逃脫格
        this.board[targetIdx] = victim;

        // 2. 攻擊方補位
        this.board[victimIdx] = attacker;
        this.board[attackerIdx] = null;

        this.isWaitingForRetreat = false;
        this.retreatData = null;

        this.lastMovedTo = victimIdx;
        this.stateHistory.push(this.hashBoard());
        // 撤退亦涉及盤面位置大幅變動，重置長追紀錄
        this.resetChaseHistory();
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

    /* ===================== 測試碼 / 設備綁定：進入流程 ===================== */

    escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, ch => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
        ));
    }

    enterHome() {
        this.showPage('start-page');
    }

    initGate() {
        const input = document.getElementById('gate-code-input');
        const btn = document.getElementById('gate-submit-btn');
        if (!input || !btn) return;

        // 僅允許英數，並自動轉大寫
        input.addEventListener('input', () => {
            const cleaned = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
            if (cleaned !== input.value) input.value = cleaned;
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.submitGate(); }
        });
        btn.addEventListener('click', () => this.submitGate());
    }

    // 載入時：有本機紀錄就跟雲端重新核對，否則停在輸入頁
    async runEntryCheck() {
        this.showPage('gate-page');
        const input = document.getElementById('gate-code-input');
        const msg = document.getElementById('gate-message');

        // 尚未設定 Supabase（本機開發）：直接進入，避免完全卡死
        if (!isGateConfigured()) {
            msg.className = 'gate-message info';
            msg.textContent = '⚙️ 尚未設定 Supabase，開發模式直接進入';
            setTimeout(() => this.enterHome(), 700);
            return;
        }

        let saved = null;
        try { saved = localStorage.getItem('dc_saved_code'); } catch (e) { /* 忽略 */ }
        if (!saved) return; // 無紀錄 → 等待手動輸入

        msg.className = 'gate-message info';
        msg.textContent = '驗證中…';
        if (input) input.value = saved;
        try {
            const r = await callRpc('redeem_code', { p_code: saved, p_device: getDeviceId() });
            const status = r && r.status;
            if (status === 'tester' || status === 'ok') {
                msg.textContent = '';
                this.enterHome();
            } else {
                // 綁定失效 / 碼被移除 / 改綁他機 → 清除本機紀錄，回到輸入頁
                try { localStorage.removeItem('dc_saved_code'); localStorage.removeItem('dc_tester'); } catch (e) {}
                if (input) input.value = '';
                msg.className = 'gate-message';
                msg.textContent = (status === 'device_mismatch')
                    ? '此測試碼已綁定其他設備，請重新輸入'
                    : '';
            }
        } catch (e) {
            msg.className = 'gate-message';
            msg.textContent = '⚠️ 無法連線驗證，請檢查網路後重試';
        }
    }

    async submitGate() {
        const input = document.getElementById('gate-code-input');
        const msg = document.getElementById('gate-message');
        const btn = document.getElementById('gate-submit-btn');
        const raw = (input.value || '').trim().toUpperCase();

        if (!raw) {
            msg.className = 'gate-message';
            msg.textContent = '請先輸入測試碼';
            return;
        }
        if (!isGateConfigured()) { this.enterHome(); return; }

        btn.disabled = true;
        msg.className = 'gate-message info';
        msg.textContent = '驗證中…';
        try {
            const r = await callRpc('redeem_code', { p_code: raw, p_device: getDeviceId() });
            const status = r && r.status;
            if (status === 'tester' || status === 'ok') {
                try {
                    localStorage.setItem('dc_saved_code', raw);
                    if (status === 'tester') localStorage.setItem('dc_tester', '1');
                    else localStorage.removeItem('dc_tester');
                } catch (e) { /* 忽略 */ }
                msg.className = 'gate-message success';
                msg.textContent = (status === 'tester') ? '測試員通過，進入遊戲…' : '驗證成功，進入遊戲…';
                setTimeout(() => this.enterHome(), 400);
            } else if (status === 'device_mismatch') {
                msg.className = 'gate-message';
                msg.textContent = '❌ 此測試碼已綁定其他設備，無法在此裝置使用';
            } else if (status === 'invalid') {
                msg.className = 'gate-message';
                msg.textContent = '❌ 測試碼錯誤，請確認後再輸入';
            } else {
                msg.className = 'gate-message';
                msg.textContent = '⚠️ 發生未知錯誤，請重試';
            }
        } catch (e) {
            msg.className = 'gate-message';
            msg.textContent = '⚠️ 連線失敗，請檢查網路後再試';
        } finally {
            btn.disabled = false;
        }
    }

    /* ===================== 測試碼管理頁 ===================== */

    initCodesAdmin() {
        const openBtn = document.getElementById('open-codes-admin');
        if (openBtn) openBtn.addEventListener('click', () => this.openCodesAdmin());

        const backBtn = document.getElementById('back-from-admin');
        if (backBtn) backBtn.addEventListener('click', () => this.showPage('sandbox-page'));

        const authBtn = document.getElementById('admin-auth-btn');
        if (authBtn) authBtn.addEventListener('click', () => this.adminAuth());
        const authInput = document.getElementById('admin-auth-input');
        if (authInput) authInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.adminAuth(); }
        });

        const refreshBtn = document.getElementById('admin-refresh');
        if (refreshBtn) refreshBtn.addEventListener('click', () => this.loadAdminData());

        const saveBtn = document.getElementById('tester-pw-save');
        if (saveBtn) saveBtn.addEventListener('click', () => this.saveTesterPw());
    }

    openCodesAdmin() {
        this.adminPassword = null;
        document.getElementById('admin-auth').classList.remove('hidden');
        document.getElementById('admin-content').classList.add('hidden');
        document.getElementById('admin-refresh').classList.add('hidden');
        const authInput = document.getElementById('admin-auth-input');
        if (authInput) authInput.value = '';
        const authMsg = document.getElementById('admin-auth-msg');
        const pwMsg = document.getElementById('tester-pw-msg');
        authMsg.className = 'gate-message';
        authMsg.textContent = '';
        pwMsg.textContent = '';
        this.showPage('codes-admin-page');

        if (!isGateConfigured()) {
            authMsg.className = 'gate-message info';
            authMsg.textContent = '⚙️ 尚未設定 Supabase，無法載入雲端資料';
        }
    }

    async adminAuth() {
        const input = document.getElementById('admin-auth-input');
        const msg = document.getElementById('admin-auth-msg');
        const pw = (input.value || '').trim();
        if (!pw) { msg.className = 'gate-message'; msg.textContent = '請輸入測試員密碼'; return; }
        if (!isGateConfigured()) { msg.className = 'gate-message'; msg.textContent = '⚙️ 尚未設定 Supabase'; return; }

        msg.className = 'gate-message info';
        msg.textContent = '驗證中…';
        try {
            const data = await callRpc('admin_data', { p_password: pw });
            if (data && data.error) {
                msg.className = 'gate-message';
                msg.textContent = '❌ 密碼錯誤';
                return;
            }
            this.adminPassword = pw;
            msg.textContent = '';
            document.getElementById('admin-auth').classList.add('hidden');
            document.getElementById('admin-content').classList.remove('hidden');
            document.getElementById('admin-refresh').classList.remove('hidden');
            this.renderAdmin(data);
        } catch (e) {
            msg.className = 'gate-message';
            msg.textContent = '⚠️ 連線失敗，請檢查網路';
        }
    }

    async loadAdminData() {
        if (!this.adminPassword) return;
        try {
            const data = await callRpc('admin_data', { p_password: this.adminPassword });
            if (data && data.error) { this.openCodesAdmin(); return; }
            this.renderAdmin(data);
            this.showToast('已重新整理');
        } catch (e) {
            this.showToast('重新整理失敗，請檢查網路');
        }
    }

    renderAdmin(data) {
        const pwInput = document.getElementById('tester-pw-input');
        if (pwInput) pwInput.value = (data && data.tester_password) || '';

        const codes = (data && Array.isArray(data.codes)) ? data.codes : [];
        const bound = codes.filter(c => c.device_id).length;

        const stats = document.getElementById('admin-stats');
        stats.innerHTML =
            `<div class="admin-stat"><b>${codes.length}</b>測試碼總數</div>` +
            `<div class="admin-stat"><b>${bound}</b>已綁定</div>` +
            `<div class="admin-stat"><b>${codes.length - bound}</b>未使用</div>`;

        const body = document.getElementById('admin-codes-body');
        body.innerHTML = '';
        codes.forEach((c, i) => {
            const isBound = !!c.device_id;
            const devFull = isBound ? this.escapeHtml(String(c.device_id)) : '';
            const dev = isBound ? devFull.slice(0, 8) + '…' : '<span class="dim">—</span>';
            const time = c.bound_at ? new Date(c.bound_at).toLocaleString('zh-TW') : '<span class="dim">—</span>';
            const badge = isBound ? '<span class="badge bound">已綁定</span>' : '<span class="badge free">未使用</span>';
            const action = isBound
                ? `<button class="mini-btn" data-code="${this.escapeHtml(c.code)}">解除綁定</button>`
                : '<span class="dim">—</span>';
            const tr = document.createElement('tr');
            tr.innerHTML =
                `<td class="dim">${i + 1}</td>` +
                `<td><code>${this.escapeHtml(c.code)}</code></td>` +
                `<td>${badge}</td>` +
                `<td title="${devFull}">${dev}</td>` +
                `<td>${time}</td>` +
                `<td>${action}</td>`;
            body.appendChild(tr);
        });

        body.querySelectorAll('.mini-btn').forEach(btn => {
            btn.addEventListener('click', () => this.unbindCode(btn.dataset.code));
        });
    }

    async saveTesterPw() {
        const input = document.getElementById('tester-pw-input');
        const msg = document.getElementById('tester-pw-msg');
        const newPw = (input.value || '').trim();
        if (!newPw) { msg.className = 'gate-message'; msg.textContent = '密碼不可為空'; return; }
        if (!this.adminPassword) return;
        if (!confirm(`確定要將測試員密碼更新為「${newPw}」？\n更新後所有設備立即生效。`)) return;

        msg.className = 'gate-message info';
        msg.textContent = '更新中…';
        try {
            const r = await callRpc('admin_set_tester', { p_old: this.adminPassword, p_new: newPw });
            if (r && r.error) {
                msg.className = 'gate-message';
                msg.textContent = (r.error === 'empty') ? '密碼不可為空' : '❌ 驗證失敗，請重新進入管理頁';
                return;
            }
            // 更新成功 → 之後的操作改用新密碼驗證
            this.adminPassword = r.tester_password || newPw;
            msg.className = 'gate-message success';
            msg.textContent = '✅ 已更新測試員密碼';
        } catch (e) {
            msg.className = 'gate-message';
            msg.textContent = '⚠️ 連線失敗，請檢查網路';
        }
    }

    async unbindCode(code) {
        if (!code || !this.adminPassword) return;
        if (!confirm(`確定要解除測試碼「${code}」的設備綁定？\n解除後該碼可重新在新設備上綁定。`)) return;
        try {
            const r = await callRpc('admin_unbind', { p_password: this.adminPassword, p_code: code });
            if (r && r.error) { this.showToast('操作失敗，請重新進入管理頁'); return; }
            this.showToast(`已解除 ${code} 的綁定`);
            this.loadAdminData();
        } catch (e) {
            this.showToast('連線失敗，請檢查網路');
        }
    }

    handleElephantTrample(from, to) {
        const { r, c } = this.getRC(to);
        const attacker = this.board[to];
        if (!attacker) return;
        
        let trampleCount = 0;

        // 修正：僅檢查上下左右 4 格 (十字方向)
        const neighbors = [
            { dr: -1, dc: 0 }, { dr: 1, dc: 0 }, { dr: 0, dc: -1 }, { dr: 0, dc: 1 }
        ];

        neighbors.forEach(n => {
            const tr = r + n.dr;
            const tc = c + n.dc;

            if (tr >= 0 && tr < BOARD_ROWS && tc >= 0 && tc < BOARD_COLS) {
                const trIdx = tr * BOARD_COLS + tc;
                const extraVictim = this.board[trIdx];
                
                // 必須是已翻開的敵對棋子，且等級低於 相 (5)
                if (extraVictim && extraVictim.isFlipped && extraVictim.side !== attacker.side) {
                    if (PIECE_TYPES[extraVictim.type].value < PIECE_TYPES['相'].value) {
                        this.captured[attacker.side].push(extraVictim);
                        this.board[trIdx] = null;
                        this.addLog('capture', { attackerName: attacker.char + '(重踏)', victimName: extraVictim.char, from: to, to: trIdx });
                        trampleCount++;
                    }
                }
            }
        });

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
            const profile = AI_PROFILES[this.aiDifficulty] || AI_PROFILES.amateur;
            const bestMove = this.chooseAIMove(profile);

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

    // ===================== AI 決策核心 =====================

    // 統一決策入口：依 profile 在「走子」與「翻棋」間做出最像人的選擇
    chooseAIMove(profile) {
        const moves = this.getAllValidMoves(this.aiSide);
        const unflipped = this.getUnflippedIndices();

        // 完全沒棋可走：只能翻棋
        if (moves.length === 0) {
            return unflipped.length > 0 ? this.chooseFlip(profile, unflipped) : null;
        }

        // 設定思考截止時間與置換表
        this.aiDeadline = Date.now() + profile.maxTime;
        this.tt = profile.useTT ? new Map() : null;

        // 對所有合法走子做搜尋評分（迭代加深，受時間預算保護）
        const scored = this.searchRoot(moves, profile);
        let bestMoveScore = -Infinity;
        for (const s of scored) if (s.score > bestMoveScore) bestMoveScore = s.score;

        // 翻棋評估（與走子分數同尺度比較）
        let flipOption = null;
        if (unflipped.length > 0) {
            flipOption = this.evaluateBestFlip(profile, unflipped);
        }

        // 翻棋明顯較優 → 翻棋
        if (flipOption && flipOption.score > bestMoveScore) {
            return { type: 'flip', index: flipOption.index };
        }

        // 否則從走子中以「人味選步層」挑選（含隨機與失誤）
        const picked = this.selectMoveWithStyle(scored, profile);
        return { type: 'move', from: picked.from, to: picked.to };
    }

    // 根節點搜尋：一律迭代加深，時間到即用上一層結果（保證不卡頓）
    searchRoot(moves, profile) {
        let ordered = this.orderMoves(moves, this.aiSide);
        const maxDepth = Math.max(1, profile.depth);
        const opp = this.opponentOf(this.aiSide);
        let result = ordered.map(m => ({ from: m.from, to: m.to, score: 0 }));

        for (let d = 1; d <= maxDepth; d++) {
            const out = [];
            let timedOut = false;
            for (const m of ordered) {
                const tok = this.aiSimMove(m.from, m.to);
                let score;
                try {
                    score = -this.negamax(d - 1, -Infinity, Infinity, opp, profile);
                } catch (e) {
                    this.aiUndoMove(m.from, m.to, tok);
                    if (e === AI_TIMEOUT) { timedOut = true; break; }
                    throw e;
                }
                this.aiUndoMove(m.from, m.to, tok);
                out.push({ from: m.from, to: m.to, score });
            }
            if (timedOut) break;           // 本層未完成，沿用上一層完整結果
            result = out;
            // 依分數重排，讓下一層先搜好棋，提升剪枝效率
            result.sort((a, b) => b.score - a.score);
            ordered = result.map(r => ({ from: r.from, to: r.to }));
            if (Date.now() > this.aiDeadline) break;
        }
        return result;
    }

    // 人味選步層：失誤 + softmax 加權隨機，避免每局重複、讓低階像人會犯錯
    selectMoveWithStyle(scored, profile) {
        if (scored.length === 1) return scored[0];

        // 機率性失誤：忽略最佳解，從中後段的合理走法隨機挑（模擬漏招）
        if (profile.blunderRate > 0 && Math.random() < profile.blunderRate) {
            const sorted = [...scored].sort((a, b) => b.score - a.score);
            const dropTop = Math.min(sorted.length - 1, Math.max(1, Math.floor(sorted.length * 0.25)));
            const pool = sorted.slice(dropTop);
            return pool[Math.floor(Math.random() * pool.length)];
        }

        // softmax 加權隨機：溫度越高越愛在相近走法間變化
        if (profile.randomTemp > 0) {
            const maxS = Math.max(...scored.map(s => s.score));
            let sum = 0;
            const weights = scored.map(s => {
                const w = Math.exp((s.score - maxS) / profile.randomTemp);
                sum += w;
                return w;
            });
            let r = Math.random() * sum;
            for (let i = 0; i < scored.length; i++) {
                r -= weights[i];
                if (r <= 0) return scored[i];
            }
        }

        // 無隨機（國士無雙）：取嚴格最佳
        let best = scored[0];
        for (const s of scored) if (s.score > best.score) best = s;
        return best;
    }

    // ---- 翻棋：以「剩餘暗子多重集合」的期望值公平評估（不偷看特定暗子身分） ----
    evaluateBestFlip(profile, unflipped) {
        if (!profile.smartFlip) {
            // 不具智慧翻棋能力者：隨機翻棋，但仍套用階段獎勵與讓步代價（避免無腦翻棋）
            const idx = unflipped[Math.floor(Math.random() * unflipped.length)];
            return { index: idx, score: this.evaluateBoard() + profile.flipBias + this.flipStrategicBonus() - 35 };
        }

        // 統計場上所有暗子的分布（此為公開可數資訊：總子數 − 已翻 − 已被吃）
        const pool = this.getHiddenPool();
        if (pool.length === 0) return null;
        const counts = {};
        for (const p of pool) {
            const k = p.side + '|' + p.type;
            if (!counts[k]) counts[k] = { count: 0, side: p.side, type: p.type };
            counts[k].count++;
        }
        const distinct = Object.values(counts);
        const total = pool.length;
        const TEMPO = 35;                       // 翻棋讓出一手的代價（靜態翻棋估值偏樂觀，需扣除）
        const strategic = this.flipStrategicBonus();

        let best = null;
        for (const tile of unflipped) {
            const original = this.board[tile];
            let ev = 0;
            for (const d of distinct) {
                // 在此格放一個假想的已翻棋子（依分布加權），評估盤面期望
                this.board[tile] = { side: d.side, type: d.type, isFlipped: true, isUpgraded: false, cooldown: 0, id: -999, char: '' };
                ev += this.evaluateBoard() * (d.count / total);
            }
            this.board[tile] = original;        // 還原真實暗子，絕不據此作弊
            ev += profile.flipBias + strategic - TEMPO;
            if (!best || ev > best.score) best = { index: tile, score: ev };
        }
        return best;
    }

    // 翻棋的策略性需求：依「遊戲階段（剩餘暗子數）」加分。
    // 用暗子數（單調遞減）而非己方翻開數，避免棋子被吃光時陷入「無限翻棋」死循環。
    flipStrategicBonus() {
        const unflipped = this.getHiddenPool().length;
        if (unflipped >= 24) return 60; // 開局：鼓勵翻棋發展
        if (unflipped >= 16) return 30; // 前中盤：適度
        if (unflipped >= 8) return 10;  // 中盤：少量
        return 0;                       // 殘局：不再為翻棋加分，專心應戰
    }

    chooseFlip(profile, unflipped) {
        if (profile.smartFlip) {
            const best = this.evaluateBestFlip(profile, unflipped);
            if (best) return { type: 'flip', index: best.index };
        }
        return { type: 'flip', index: unflipped[Math.floor(Math.random() * unflipped.length)] };
    }

    getHiddenPool() {
        const pool = [];
        for (let i = 0; i < 32; i++) {
            const p = this.board[i];
            if (p && !p.isFlipped) pool.push(p);
        }
        return pool;
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

    // 盤面評估（以 side 視角，正值代表對該方有利）
    scoreForSide(side) {
        return (side === this.aiSide ? 1 : -1) * this.evaluateBoard();
    }

    opponentOf(side) {
        return side === 'red' ? 'black' : 'red';
    }

    // negamax + alpha-beta + 置換表 + 靜態吃子搜尋
    negamax(depth, alpha, beta, side, profile) {
        if (Date.now() > this.aiDeadline) throw AI_TIMEOUT;

        const origAlpha = alpha;
        const ttKey = profile.useTT ? (side + this.aiHash()) : null;
        if (ttKey && this.tt.has(ttKey)) {
            const e = this.tt.get(ttKey);
            if (e.depth >= depth) {
                if (e.flag === 0) return e.value;                    // 精確值
                else if (e.flag === 1 && e.value > alpha) alpha = e.value; // 下界
                else if (e.flag === -1 && e.value < beta) beta = e.value;  // 上界
                if (alpha >= beta) return e.value;
            }
        }

        if (depth <= 0) {
            return profile.quiescence
                ? this.quiescence(alpha, beta, side, profile)
                : this.scoreForSide(side);
        }

        const moves = this.genSearchMoves(side);
        if (moves.length === 0) {
            // 無子可動：若已無己方翻開棋子→慘敗；否則靜態評估（仍可能有暗子）
            const myFlipped = this.board.filter(p => p && p.side === side && p.isFlipped).length;
            return myFlipped === 0 ? -90000 - depth : this.scoreForSide(side);
        }

        const ordered = this.orderMoves(moves, side);
        const opp = this.opponentOf(side);
        let best = -Infinity;
        for (const m of ordered) {
            const tok = this.aiSimMove(m.from, m.to);
            let val;
            try {
                val = -this.negamax(depth - 1, -beta, -alpha, opp, profile);
            } catch (e) {
                this.aiUndoMove(m.from, m.to, tok);
                throw e;
            }
            this.aiUndoMove(m.from, m.to, tok);
            if (val > best) best = val;
            if (val > alpha) alpha = val;
            if (alpha >= beta) break;          // beta 剪枝
        }

        if (ttKey) {
            const flag = best <= origAlpha ? -1 : (best >= beta ? 1 : 0);
            this.tt.set(ttKey, { depth, value: best, flag });
        }
        return best;
    }

    // 靜態吃子搜尋：把連續吃子算到穩定，消除地平線效應
    quiescence(alpha, beta, side, profile) {
        if (Date.now() > this.aiDeadline) throw AI_TIMEOUT;

        const standPat = this.scoreForSide(side);
        if (standPat >= beta) return beta;
        if (standPat > alpha) alpha = standPat;

        const caps = this.orderMoves(this.genCaptureMoves(side), side);
        const opp = this.opponentOf(side);
        for (const m of caps) {
            if (profile.see && this.seeCapture(m.from, m.to) < 0) continue; // 略過虧本兌子
            const tok = this.aiSimMove(m.from, m.to);
            let val;
            try {
                val = -this.quiescence(-beta, -alpha, opp, profile);
            } catch (e) {
                this.aiUndoMove(m.from, m.to, tok);
                throw e;
            }
            this.aiUndoMove(m.from, m.to, tok);
            if (val >= beta) return beta;
            if (val > alpha) alpha = val;
        }
        return alpha;
    }

    // 搜尋用走法生成（不做禁手過濾，提升深層搜尋效率）
    genSearchMoves(side) {
        const moves = [];
        for (let i = 0; i < 32; i++) {
            const p = this.board[i];
            if (p && p.side === side && p.isFlipped) {
                for (let j = 0; j < 32; j++) {
                    if (this.tryMovePreview(i, j)) moves.push({ from: i, to: j });
                }
            }
        }
        return moves;
    }

    // 只生成吃子走法（供 quiescence 使用）
    genCaptureMoves(side) {
        const moves = [];
        for (let i = 0; i < 32; i++) {
            const p = this.board[i];
            if (p && p.side === side && p.isFlipped) {
                for (let j = 0; j < 32; j++) {
                    if (this.board[j] && this.tryMovePreview(i, j)) moves.push({ from: i, to: j });
                }
            }
        }
        return moves;
    }

    // 靜態交換評估（SEE）：from→to 這次吃子的淨物質收益
    seeCapture(from, to) {
        const victim = this.board[to];
        if (!victim) return 0;
        const gain = PIECE_TYPES[victim.type].value;
        const tok = this.aiSimMove(from, to);
        const ret = gain - this.seeAt(to, this.opponentOf(this.board[to].side));
        this.aiUndoMove(from, to, tok);
        return ret;
    }

    // 遞迴計算某格被反覆吃子後，sideToMove 方能取得的淨值
    seeAt(to, sideToMove) {
        const attackerIdx = this.leastValuableAttacker(to, sideToMove);
        if (attackerIdx === -1) return 0;
        const victimVal = PIECE_TYPES[this.board[to].type].value;
        const tok = this.aiSimMove(attackerIdx, to);
        const ret = Math.max(0, victimVal - this.seeAt(to, this.opponentOf(sideToMove)));
        this.aiUndoMove(attackerIdx, to, tok);
        return ret;
    }

    // 找出能吃掉 to 格、且本身價值最低的攻擊者（SEE 用）
    leastValuableAttacker(to, side) {
        let bestIdx = -1, bestVal = Infinity;
        for (let i = 0; i < 32; i++) {
            const p = this.board[i];
            if (p && p.side === side && p.isFlipped && this.canCapture(i, to)) {
                const v = PIECE_TYPES[p.type].value;
                if (v < bestVal) { bestVal = v; bestIdx = i; }
            }
        }
        return bestIdx;
    }

    // 含升級狀態的盤面雜湊（置換表用，補足 hashBoard 未含的升級資訊）
    aiHash() {
        let s = '';
        for (let i = 0; i < 32; i++) {
            const p = this.board[i];
            if (!p) { s += '.'; continue; }
            s += (p.side === 'red' ? 'r' : 'b') + p.type + (p.isFlipped ? (p.isUpgraded ? 'U' : 'f') : 'd');
        }
        return s;
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
    // 升級感知的模擬移動：吃子時會讓攻擊方升級（與真實規則一致）
    aiSimMove(from, to) {
        const captured = this.board[to];
        const attacker = this.board[from];
        const prevUpgraded = attacker.isUpgraded;
        if (captured && !attacker.isUpgraded) attacker.isUpgraded = true; // 吃子即升級
        this.board[to] = attacker;
        this.board[from] = null;
        return { captured, prevUpgraded };
    }

    // 還原升級感知的模擬移動
    aiUndoMove(from, to, tok) {
        const attacker = this.board[to];
        if (attacker) attacker.isUpgraded = tok.prevUpgraded;
        this.board[from] = attacker;
        this.board[to] = tok.captured;
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
        this.stopGuideAnimations();           // 清除舊計時器，避免重複進入頁面殘留動畫
        this.guideTimers = [];
        const guideList = document.getElementById('guide-list');
        guideList.innerHTML = this.buildGuideHTML();
        // 啟動所有技能 / 機制示範動畫
        this.getGuideDemos().forEach(d => this.startFrameDemo(d.id, d.steps));
    }

    // 組建完整玩法解說的 HTML（六大區塊）
    buildGuideHTML() {
        const ladder = ['帥', '仕', '相', '俥', '傌', '砲', '兵']
            .map(t => `<span class="rank-chip">${t}</span>`).join('<span class="rank-gt">›</span>');

        const skills = [
            { type: '帥', skill: '威震八方', desc: '升級後可沿<b>對角線移動或吃子</b>一格（仍<b>不能吃兵</b>）。', move: true },
            { type: '仕', skill: '越級刺殺', desc: '可沿<b>對角線越級</b>吃子，連最高階的帥／將也能擒拿。', captureOnly: true },
            { type: '相', skill: '重踏', desc: '吃子後，<b>連帶震碎</b>落點上下左右、階級低於相的已翻敵棋。' },
            { type: '俥', skill: '衝鋒', desc: '直線路徑<b>無阻隔</b>時，可長驅直入<b>越級</b>吃子。', captureOnly: true },
            { type: '傌', skill: '凌空', desc: '可<b>跳過緊鄰的一顆棋子</b>，於直線上越級攻擊。', captureOnly: true },
            { type: '砲', skill: '神砲', desc: '升級後<b>無視阻隔</b>，可飛越棋子遠程轟擊，並<b>移動到吃子格</b>。', captureOnly: true },
            { type: '兵', skill: '埋伏夾擊', desc: '<b>兩隻</b>兵卒同時貼住目標，即可<b>越級</b>吃下被包圍的高階敵棋。', noUpgrade: true },
        ];
        const tagFor = (s) => (s.captureOnly ? '<span class="tag-cap">僅限吃子</span>' : '')
            + (s.move ? '<span class="tag-move">可移動</span>' : '')
            + (s.noUpgrade ? '<span class="tag-free">免升級</span>' : '');
        const skillCards = skills.map(s => `
            <div class="guide-card">
                <h3>${s.type}<span class="skill-tag">${s.skill}</span></h3>
                <div class="tag-row">${tagFor(s)}</div>
                <p class="guide-desc">${s.desc}</p>
                <div class="demo-container"><div class="demo-board" id="demo-${s.type}">${this.createDemoTiles()}</div></div>
                <div class="demo-caption" id="demo-${s.type}-cap"></div>
            </div>`).join('');

        return `
        <section class="guide-section intro">
            <h3 class="section-title">🎯 遊戲目標</h3>
            <p class="guide-desc">輪流行動，率先<b>吃光對方所有棋子</b>者獲勝。每顆棋子吃子後會<b>升級覺醒</b>並解鎖專屬技能，讓戰局瞬息萬變。</p>
        </section>

        <section class="guide-section">
            <h3 class="section-title">⚔️ 基本玩法</h3>
            <div class="rule-row"><span class="rule-ic">🔄</span><div><b>翻棋決定先手</b>：棋盤 8×4＝32 格，棋子背面朝上。你翻開的<b>第一顆棋子</b>顏色，即為你的陣營。</div></div>
            <div class="rule-row"><span class="rule-ic">➡️</span><div><b>每回合擇一</b>：翻開一顆暗棋，或將己方棋子沿<b>上下左右</b>移動一格。</div></div>
            <div class="rule-row"><span class="rule-ic">🥋</span><div><b>吃子靠階級</b>：高階可吃同階或更低階——
                <div class="rank-ladder">${ladder}</div>
                <div class="rank-note">特例：<b>兵可吃帥</b>（以下犯上）、<b>帥不可吃兵</b>。</div>
            </div></div>
            <div class="rule-row"><span class="rule-ic">💥</span><div><b>砲的隔子吃法</b>：未升級的砲需<b>正好隔一顆棋子</b>（隔山打牛）才能直線吃子。</div></div>
        </section>

        <section class="guide-section">
            <h3 class="section-title">⬆️ 升級覺醒</h3>
            <div class="rule-row"><span class="rule-ic">✨</span><div>任何棋子<b>成功吃子後立即升級</b>（棋身泛金光），解鎖下方對應的專屬技能。</div></div>
            <div class="rule-row"><span class="rule-ic">⏳</span><div>發動特殊技能（斜吃、衝鋒、凌空、神砲等）後會進入<b>冷卻</b>，需間隔一回合才能再用；冷卻中仍可用一般階級壓制吃子。</div></div>
            <div class="rule-row"><span class="rule-ic">⚔️</span><div><b>技能多為「吃子專用」</b>：除了帥可斜向移動外，<b>仕／俥／傌／砲</b>的特殊招式<b>只能用於吃子</b>，平時移動仍是上下左右一格；而<b>兵的埋伏無需升級</b>即可發動。</div></div>
        </section>

        <section class="guide-section">
            <h3 class="section-title">✨ 七棋子技能</h3>
            <div class="skill-grid">${skillCards}</div>
        </section>

        <section class="guide-section">
            <h3 class="section-title">🛡️ 特殊機制</h3>
            <div class="skill-grid"><div class="guide-card">
                <h3>兵<span class="skill-tag">撤退</span></h3>
                <p class="guide-desc">升級後的兵被攻擊時，會先<b>撤退</b>到鄰近空格、由攻擊方補上原位；須<b>連續攻擊兩次</b>才能真正擊殺。</p>
                <div class="demo-container"><div class="demo-board" id="demo-撤退">${this.createDemoTiles()}</div></div>
                <div class="demo-caption" id="demo-撤退-cap"></div>
            </div></div>
        </section>

        <section class="guide-section">
            <h3 class="section-title">🚫 禁手規則</h3>
            <div class="rule-row"><span class="rule-ic">♻️</span><div><b>三循環禁手</b>：同一盤面連續出現三次時，不得再走出造成重複的那一步。</div></div>
            <div class="rule-row"><span class="rule-ic">🎯</span><div><b>長捉禁手</b>：禁止反覆來回追殺同一顆無法逃脫的棋子，必須變著。</div></div>
        </section>`;
    }

    // 各示範動畫的影格資料（tile 0-8 對應 3×3 格）
    getGuideDemos() {
        const P = (k, t, cls, ch) => ({ k, t, cls, ch });
        return [
            { id: 'demo-帥', steps: [
                { caption: '帥升級後，可沿對角線走或吃一格', hold: 1500, pieces: [P('h', 4, 'gold', '帥'), P('v', 0, 'enemy', '俥')] },
                { caption: '斜線突襲！吃掉敵俥（仍不能吃兵）', hold: 1700, pieces: [P('h', 0, 'gold', '帥')] },
            ]},
            { id: 'demo-仕', steps: [
                { caption: '仕可沿對角線「越級」擒敵', hold: 1500, pieces: [P('h', 4, 'gold', '仕'), P('v', 0, 'enemy', '帥')] },
                { caption: '越級刺殺！連敵帥也能拿下', hold: 1700, pieces: [P('h', 0, 'gold', '仕')] },
            ]},
            { id: 'demo-相', steps: [
                { caption: '相吃子後，震碎落點四周的低階敵棋', hold: 1600, pieces: [P('h', 6, 'gold', '相'), P('v', 7, 'enemy', '砲'), P('a', 4, 'enemy', '兵'), P('b', 8, 'enemy', '卒')] },
                { caption: '重踏！周圍低階敵棋一併粉碎', hold: 1900, effect: 'shake', pieces: [P('h', 7, 'gold', '相')] },
            ]},
            { id: 'demo-俥', steps: [
                { caption: '直線無阻隔時，俥可越級衝鋒', hold: 1500, pieces: [P('h', 6, 'gold', '俥'), P('v', 0, 'enemy', '帥')] },
                { caption: '衝鋒！長驅直入擒敵', hold: 1700, pieces: [P('h', 0, 'gold', '俥')] },
            ]},
            { id: 'demo-傌', steps: [
                { caption: '傌可跳過緊鄰的一子，越級空襲', hold: 1500, pieces: [P('h', 8, 'gold', '傌'), P('m', 5, 'hurdle', '兵'), P('v', 2, 'enemy', '帥')] },
                { caption: '凌空！越子擒敵', hold: 1700, pieces: [P('h', 2, 'gold', '傌'), P('m', 5, 'hurdle', '兵')] },
            ]},
            { id: 'demo-砲', steps: [
                { caption: '神砲無視阻隔，飛越棋子遠程轟擊', hold: 1500, pieces: [P('h', 6, 'gold', '砲'), P('m', 7, 'hurdle', '兵'), P('v', 8, 'enemy', '帥')] },
                { caption: '轟！砲越子擊殺並移動到該格', hold: 1700, effect: 'shake', pieces: [P('h', 8, 'gold', '砲'), P('m', 7, 'hurdle', '兵')] },
            ]},
            { id: 'demo-兵', steps: [
                { caption: '兩隻兵卒貼住目標即可埋伏（無需升級）', hold: 1600, pieces: [P('v', 4, 'enemy', '士'), P('a', 1, 'ally', '兵'), P('h', 3, 'ally', '兵')] },
                { caption: '埋伏！越級吃下被包圍的敵士', hold: 1800, pieces: [P('h', 4, 'ally', '兵'), P('a', 1, 'ally', '兵')] },
            ]},
            { id: 'demo-撤退', steps: [
                { caption: '升級的兵遭攻擊，不會立刻陣亡', hold: 1500, pieces: [P('e', 3, 'enemy', '俥'), P('h', 4, 'gold', '兵')] },
                { caption: '兵撤退至空格，攻擊方補上原位', hold: 1800, pieces: [P('e', 4, 'enemy', '俥'), P('h', 5, 'gold', '兵')] },
            ]},
        ];
    }

    createDemoTiles() {
        let html = '';
        for (let i = 0; i < 9; i++) html += `<div class="demo-tile"></div>`;
        return html;
    }

    // 影格式示範動畫引擎：依 steps 依序擺放棋子並更新說明文字，循環播放
    startFrameDemo(id, steps) {
        const board = document.getElementById(id);
        if (!board) return;
        const cap = document.getElementById(id + '-cap');
        const tiles = board.querySelectorAll('.demo-tile');
        const els = {}; // 以 key 持久化棋子，使其在影格間平滑移動

        const getEl = (k) => {
            if (!els[k]) {
                const e = document.createElement('div');
                e.className = 'demo-piece';
                board.appendChild(e);
                els[k] = e;
            }
            return els[k];
        };

        let frame = 0;
        const render = () => {
            const step = steps[frame];
            if (cap) cap.textContent = step.caption || '';

            const shown = new Set();
            (step.pieces || []).forEach(p => {
                shown.add(p.k);
                const e = getEl(p.k);
                const t = tiles[p.t];
                e.className = 'demo-piece ' + (p.cls || '');
                e.textContent = p.ch || '';
                e.style.left = t.offsetLeft + 'px';
                e.style.top = t.offsetTop + 'px';
                e.style.width = t.offsetWidth + 'px';
                e.style.height = t.offsetHeight + 'px';
                e.style.opacity = '1';
            });
            // 未在本影格出現的棋子淡出（表示被吃 / 移走）
            Object.keys(els).forEach(k => { if (!shown.has(k)) els[k].style.opacity = '0'; });

            if (step.effect === 'shake') {
                board.style.animation = 'none';
                requestAnimationFrame(() => { board.style.animation = 'shake 0.4s'; });
            }

            frame = (frame + 1) % steps.length;
            this.guideTimers.push(setTimeout(render, step.hold || 1500));
        };
        render();
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
