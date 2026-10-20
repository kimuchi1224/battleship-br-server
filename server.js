const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
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

let gameState = 'lobby';
let settings = {
  gridSize: 10,
  botCount: 3 // デフォルトでBotを3体配置
};
let players = {};
let mapObjects = {};
let currentTurn = 0;
let safeZoneRadius = 5;

function generateMap(size) {
  mapObjects = {};
  safeZoneRadius = Math.floor(size / 2);
  const center = Math.floor(size / 2);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rand = Math.random();
      const key = `${x},${y}`;
      const distFromCenter = Math.abs(x - center) + Math.abs(y - center);
      
      if (rand < 0.15 && distFromCenter > 1) {
        mapObjects[key] = { type: 'rock' };
      } else if (rand < 0.25) {
        mapObjects[key] = { type: 'treasure', opened: false };
      } else if (rand < 0.40) {
        mapObjects[key] = { type: 'grass' };
      }
    }
  }
}

io.on('connection', (socket) => {
  console.log(`ユーザー接続: ${socket.id}`);

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
    ready: false,
    isBot: false
  };

  updateGameData();

  socket.on('updateSettings', (newSettings) => {
    if (gameState !== 'lobby') return;
    settings.gridSize = parseInt(newSettings.gridSize) || 10;
    settings.botCount = parseInt(newSettings.botCount) !== undefined ? parseInt(newSettings.botCount) : 3;
    io.emit('settingsUpdated', settings);
  });

  socket.on('toggleReady', () => {
    if (gameState !== 'lobby') return;
    players[socket.id].ready = !players[socket.id].ready;
    updateGameData();
  });

  socket.on('startGame', () => {
    if (gameState !== 'lobby') return;
    
    gameState = 'playing';
    currentTurn = 1;
    generateMap(settings.gridSize);

    // 1. 一度既存のBotを全削除して初期化
    for (let id in players) {
      if (players[id].isBot) {
        delete players[id];
      }
    }

    // 2. Botを指定数生成
    for (let i = 1; i <= settings.botCount; i++) {
      const botId = `bot_${i}`;
      players[botId] = {
        id: botId,
        name: `🤖 Bot_${i}`,
        x: 0,
        y: 0,
        hp: 100,
        ammo: 5,
        inventory: [],
        action: null,
        alive: true,
        ready: true,
        isBot: true
      };
    }

    // 3. 全プレイヤー（実人＋Bot）をランダム配置
    const activePlayers = Object.values(players);
    activePlayers.forEach((p) => {
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

  // すべての生存プレイヤー（実人＋Bot）が行動を選択したかチェック
  const allSubmitted = alivePlayers.every(p => p.action !== null);
  if (allSubmitted) {
    resolveTurn();
  }
}

// Botの行動を自動生成する関数
function decideBotActions() {
  const aliveBots = Object.values(players).filter(p => p.alive && p.isBot);
  aliveBots.forEach(bot => {
    // 50%の確率で移動、50%の確率で周囲への攻撃
    const isAttack = Math.random() < 0.5 && bot.ammo > 0;
    
    if (isAttack) {
      // 近くのランダムなマスを攻撃
      const targetX = Math.max(0, Math.min(settings.gridSize - 1, bot.x + (Math.floor(Math.random() * 3) - 1)));
      const targetY = Math.max(0, Math.min(settings.gridSize - 1, bot.y + (Math.floor(Math.random() * 3) - 1)));
      bot.action = { type: 'attack', targetX, targetY };
    } else {
      // ランダムな隣接マスへ移動
      const dx = Math.floor(Math.random() * 3) - 1;
      const dy = Math.floor(Math.random() * 3) - 1;
      const newX = Math.max(0, Math.min(settings.gridSize - 1, bot.x + dx));
      const newY = Math.max(0, Math.min(settings.gridSize - 1, bot.y + dy));
      bot.action = { type: 'move', x: newX, y: newY };
    }
  });
}

function resolveTurn() {
  // ターン解決前にBotに行動を決定させる
  decideBotActions();

  let logs = [];
  const alivePlayers = Object.values(players).filter(p => p.alive);
  const center = Math.floor(settings.gridSize / 2);

  logs.push(`--- ターン ${currentTurn} 解決 ---`);

  // 1. 移動処理
  alivePlayers.forEach(p => {
    if (p.action && p.action.type === 'move') {
      const { x, y } = p.action;
      if (x >= 0 && x < settings.gridSize && y >= 0 && y < settings.gridSize) {
        const key = `${x},${y}`;
        if (mapObjects[key] && mapObjects[key].type === 'rock') {
          logs.push(`${p.name} は岩に阻まれて移動できなかった`);
        } else {
          p.x = x;
          p.y = y;
          logs.push(`${p.name} が (${x}, ${y}) に移動した`);

          if (mapObjects[key] && mapObjects[key].type === 'treasure' && !mapObjects[key].opened) {
            mapObjects[key].opened = true;
            p.ammo += 3;
            logs.push(`✨ ${p.name} が宝箱を発見！弾薬+3獲得！`);
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

  // 3. 安全地帯縮小と毒ダメージ
  if (currentTurn % 3 === 0 && safeZoneRadius > 2) {
    safeZoneRadius--;
    logs.push(`⚠️ 安全地帯が縮小した！（安全半径: ${safeZoneRadius}）`);
  }

  alivePlayers.forEach(p => {
    const distFromCenter = Math.max(Math.abs(p.x - center), Math.abs(p.y - center));
    if (distFromCenter > safeZoneRadius) {
      p.hp -= 20;
      logs.push(`💨 ${p.name} は安全地帯の外で毒ダメージ20を受けた！`);
      if (p.hp <= 0) {
        p.alive = false;
        logs.push(`💀 ${p.name} は毒に呑まれ沈没した...`);
      }
    }
  });

  alivePlayers.forEach(p => { p.action = null; });
  currentTurn++;

  const remainingAlive = Object.values(players).filter(p => p.alive);
  if (remainingAlive.length <= 1) {
    gameState = 'ended';
    if (remainingAlive.length === 1) {
      logs.push(`🏆 勝利者: ${remainingAlive[0].name} !!!`);
    } else {
      logs.push(`引き分け`);
    }
  }

  io.emit('turnResult', { players, mapObjects, logs, gameState, safeZoneRadius });
  updateGameData();
}

function updateGameData() {
  io.emit('updateState', { players, gameState, settings, safeZoneRadius });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`サーバー起動: ポート ${PORT}`);
});
