const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// CORS設定（ご自身のGitHub PagesのURLに変更してください）
const ALLOWED_ORIGIN = "https://kimuchi1224.github.io";

app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ["GET", "POST"]
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST"]
  }
});

app.use(express.static('public'));

// ゲーム状態の管理
let gameState = 'lobby'; // 'lobby', 'playing', 'ended'
let settings = {
  gridSize: 10,
  maxTurns: 30
};
let players = {};
let mapObjects = {}; // { 'x,y': { type: 'rock'/'treasure'/'grass', hp/item } }
let currentTurn = 0;
let safeZoneRadius = 5; // 縮小安全地帯の半径（中央からの距離）

// マップ生成
function generateMap(size) {
  mapObjects = {};
  safeZoneRadius = Math.floor(size / 2);
  const center = Math.floor(size / 2);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rand = Math.random();
      const key = `${x},${y}`;
      // 中央付近は岩や宝箱を少なめに
      const distFromCenter = Math.abs(x - center) + Math.abs(y - center);
      
      if (rand < 0.15 && distFromCenter > 1) {
        mapObjects[key] = { type: 'rock' }; // 岩（障害物）
      } else if (rand < 0.25) {
        mapObjects[key] = { type: 'treasure', opened: false }; // 宝箱
      } else if (rand < 0.40) {
        mapObjects[key] = { type: 'grass' }; // 草原（隠れやすい等）
      }
    }
  }
}

io.on('connection', (socket) => {
  console.log(`ユーザー接続: ${socket.id}`);

  // プレイヤー初期化（ロビー参加）
  players[socket.id] = {
    id: socket.id,
    name: `Player_${socket.id.slice(0, 4)}`,
    x: 0,
    y: 0,
    hp: 100,
    ammo: 5,
    inventory: [],
    action: null,
    alive: true,
    ready: false
  };

  updateGameData();

  // ホストまたはプレイヤーからの設定変更
  socket.on('updateSettings', (newSettings) => {
    if (gameState !== 'lobby') return;
    settings.gridSize = parseInt(newSettings.gridSize) || 10;
    io.emit('settingsUpdated', settings);
  });

  // 準備完了切り替え
  socket.on('toggleReady', () => {
    if (gameState !== 'lobby') return;
    players[socket.id].ready = !players[socket.id].ready;
    updateGameData();
  });

  // ゲーム開始（全員が準備完了、または誰でも開始可能）
  socket.on('startGame', () => {
    if (gameState !== 'lobby') return;
    
    gameState = 'playing';
    currentTurn = 1;
    generateMap(settings.gridSize);

    // プレイヤーをランダムな位置に配置
    const activePlayers = Object.values(players);
    activePlayers.forEach((p, index) => {
      p.x = Math.floor(Math.random() * settings.gridSize);
      p.y = Math.floor(Math.random() * settings.gridSize);
      p.hp = 100;
      p.ammo = 5;
      p.alive = true;
      p.action = null;
    });

    io.emit('gameStarted', { settings, mapObjects });
    updateGameData();
  });

  // 行動の受信
  socket.on('submitAction', (actionData) => {
    if (gameState !== 'playing' || !players[socket.id] || !players[socket.id].alive) return;
    players[socket.id].action = actionData;
    checkAllActionsSubmitted();
  });

  socket.on('disconnect', () => {
    console.log(`ユーザー切断: ${socket.id}`);
    delete players[socket.id];
    updateGameData();
  });
});

function checkAllActionsSubmitted() {
  const alivePlayers = Object.values(players).filter(p => p.alive);
  if (alivePlayers.length === 0) return;

  const allSubmitted = alivePlayers.every(p => p.action !== null);
  if (allSubmitted) {
    resolveTurn();
  }
}

// ターン解決処理
function resolveTurn() {
  let logs = [];
  const alivePlayers = Object.values(players).filter(p => p.alive);
  const center = Math.floor(settings.gridSize / 2);

  logs.push(`--- ターン ${currentTurn} 解決 ---`);

  // 1. 移動処理
  alivePlayers.forEach(p => {
    if (p.action && p.action.type === 'move') {
      const { x, y } = p.action;
      // 範囲内かチェック
      if (x >= 0 && x < settings.gridSize && y >= 0 && y < settings.gridSize) {
        const key = `${x},${y}`;
        // 岩チェック
        if (mapObjects[key] && mapObjects[key].type === 'rock') {
          logs.push(`${p.name} は岩に阻まれて移動できなかった`);
        } else {
          p.x = x;
          p.y = y;
          logs.push(`${p.name} が (${x}, ${y}) に移動した`);

          // 宝箱チェック
          if (mapObjects[key] && mapObjects[key].type === 'treasure' && !mapObjects[key].opened) {
            mapObjects[key].opened = true;
            p.ammo += 3;
            p.inventory.push('強化パーツ');
            logs.push(`✨ ${p.name} が宝箱を発見！弾薬+3＆アイテム獲得！`);
          }
        }
      }
    }
  });

  // 2. 攻撃処理
  alivePlayers.forEach(p => {
    if (p.action && p.action.type === 'attack') {
      if (p.ammo <= 0) {
        logs.push(`${p.name} は弾切れで攻撃できなかった！`);
        return;
      }
      p.ammo--;
      const { targetX, targetY } = p.action;
      logs.push(`${p.name} が (${targetX}, ${targetY}) を砲撃！`);

      // 命中判定
      alivePlayers.forEach(target => {
        if (target.id !== p.id && target.x === targetX && target.y === targetY) {
          target.hp -= 35;
          logs.push(`🎯 命中！ ${target.name} に35ダメージ！`);
          if (target.hp <= 0) {
            target.alive = false;
            logs.push(`💀 ${target.name} は沈没した...`);
          }
        }
      });
    }
  });

  // 3. 安全地帯（縮小エリア）によるダメージ判定
  // ターン経過ごとに許容半径が狭くなる
  if (currentTurn % 3 === 0 && safeZoneRadius > 2) {
    safeZoneRadius--;
    logs.push(`⚠️ 毒ガスが蔓延し、安全地帯が縮小した！（安全半径: ${safeZoneRadius}）`);
  }

  alivePlayers.forEach(p => {
    const distFromCenter = Math.max(Math.abs(p.x - center), Math.abs(p.y - center));
    if (distFromCenter > safeZoneRadius) {
      p.hp -= 20;
      logs.push(`💨 ${p.name} は安全地帯の外にいるため、毒ダメージ20を受けた！`);
      if (p.hp <= 0) {
        p.alive = false;
        logs.push(`💀 ${p.name} は毒ガスに呑み込まれて沈没した...`);
      }
    }
  });

  // 行動リセット
  alivePlayers.forEach(p => { p.action = null; });
  currentTurn++;

  // 勝利判定
  const remainingAlive = Object.values(players).filter(p => p.alive);
  if (remainingAlive.length <= 1) {
    gameState = 'ended';
    if (remainingAlive.length === 1) {
      logs.path = [];
      logs.push(`🏆 勝利者: ${remainingAlive[0].name} !!!`);
    } else {
      logs.push(`引き分け (生存者なし)`);
    }
  }

  io.emit('turnResult', { players, mapObjects, logs, gameState, safeZoneRadius });
  updateGameData();
}

function updateGameData() {
  io.emit('updateState', { players, gameState, settings, safeZoneRadius });
}

// ⚠️ 最重要：Renderが指定するポート（process.env.PORT）で必ず起動する
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`サーバー起動: ポート ${PORT}`);
});
