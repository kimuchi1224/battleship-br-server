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
  botCount: 3
};
let players = {};
let mapObjects = {};
let currentTurn = 0;
let safeZoneRadius = 5;
let hostSocketId = null; // ホストのID

function generateMap(size) {
  mapObjects = {};
  safeZoneRadius = Math.floor(size / 2);
  const center = Math.floor(size / 2);

  let gridElevations = Array(size).fill(0).map(() => Array(size).fill(1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      gridElevations[y][x] = Math.floor(Math.random() * 4);
    }
  }

  for (let iter = 0; iter < 2; iter++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let current = gridElevations[y][x];
        const neighbors = [[x+1, y], [x-1, y], [x, y+1], [x, y-1]];
        neighbors.forEach(([nx, ny]) => {
          if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
            if (Math.abs(current - gridElevations[ny][nx]) >= 2) {
              current = Math.round((current + gridElevations[ny][nx]) / 2);
            }
          }
        });
        gridElevations[y][x] = Math.max(0, Math.min(3, current));
      }
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const key = `${x},${y}`;
      let objType = null;
      const rand = Math.random();
      if (rand < 0.15) {
        objType = 'treasure';
      } else if (rand < 0.30) {
        objType = 'grass';
      }

      mapObjects[key] = {
        elevation: gridElevations[y][x],
        type: objType,
        opened: false
      };
    }
  }
}

// ホストを再割り当てする関数
function assignHostIfNeeded() {
  const humanSockets = Object.keys(players).filter(id => !players[id].isBot);
  if (humanSockets.length > 0) {
    if (!players[hostSocketId] || players[hostSocketId].isBot) {
      hostSocketId = humanSockets[0];
    }
  } else {
    hostSocketId = null;
  }
}

io.on('connection', (socket) => {
  console.log(`ユーザー接続: ${socket.id}`);

  players[socket.id] = {
    id: socket.id,
    name: `Player_${socket.id.slice(0, 4)}`,
    hp: 100,
    ammo: 5,
    inventory: ['標準砲弾'],
    action: null,
    alive: true,
    ready: false,
    isBot: false,
    x: 0,
    y: 0
  };

  assignHostIfNeeded();

  if (gameState === 'playing' || gameState === 'ended') {
    players[socket.id].x = Math.floor(Math.random() * settings.gridSize);
    players[socket.id].y = Math.floor(Math.random() * settings.gridSize);
    socket.emit('gameStarted', { settings, mapObjects });
  }

  updateGameData();

  // ハンドルネーム変更
  socket.on('updateName', (newName) => {
    if (players[socket.id] && newName.trim() !== '') {
      players[socket.id].name = newName.trim().slice(0, 15);
      updateGameData();
    }
  });

  // 設定変更（ホストのみ）
  socket.on('updateSettings', (newSettings) => {
    if (gameState !== 'lobby' || socket.id !== hostSocketId) return;
    settings.gridSize = parseInt(newSettings.gridSize) || 10;
    settings.botCount = parseInt(newSettings.botCount) !== undefined ? parseInt(newSettings.botCount) : 3;
    io.emit('settingsUpdated', settings);
  });

  socket.on('toggleReady', () => {
    if (gameState !== 'lobby') return;
    players[socket.id].ready = !players[socket.id].ready;
    updateGameData();
  });

  // ゲーム開始（ホストのみ、または全員準備完了時）
  socket.on('startGame', () => {
    if (gameState !== 'lobby' || socket.id !== hostSocketId) return;
    
    gameState = 'playing';
    currentTurn = 1;
    generateMap(settings.gridSize);

    for (let id in players) {
      if (players[id].isBot) delete players[id];
    }

    for (let i = 1; i <= settings.botCount; i++) {
      const botId = `bot_${i}`;
      players[botId] = {
        id: botId,
        name: `🤖 Bot_${i}`,
        hp: 100,
        ammo: 5,
        inventory: ['標準砲弾'],
        action: null,
        alive: true,
        ready: true,
        isBot: true,
        x: 0,
        y: 0
      };
    }

    Object.values(players).forEach((p) => {
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

  // ゲーム強制終了（ホスト権限）
  socket.on('forceEndGame', () => {
    if (socket.id !== hostSocketId) return;
    gameState = 'lobby';
    for (let id in players) {
      if (players[id].isBot) {
        delete players[id];
      } else {
        players[id].ready = false;
        players[id].action = null;
        players[id].alive = true;
      }
    }
    updateGameData();
  });

  socket.on('returnToLobby', () => {
    gameState = 'lobby';
    for (let id in players) {
      if (players[id].isBot) {
        delete players[id];
      } else {
        players[id].ready = false;
        players[id].action = null;
        players[id].alive = true;
      }
    }
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
    assignHostIfNeeded();
    updateGameData();
  });
});

function checkAllActionsSubmitted() {
  const alivePlayers = Object.values(players).filter(p => p.alive);
  if (alivePlayers.length === 0) return;

  const aliveHumanPlayers = alivePlayers.filter(p => !p.isBot);
  if (aliveHumanPlayers.every(p => p.action !== null)) {
    decideBotActions();
    resolveTurn();
  }
}

function decideBotActions() {
  const aliveBots = Object.values(players).filter(p => p.alive && p.isBot);
  aliveBots.forEach(bot => {
    const isAttack = Math.random() < 0.5 && bot.ammo > 0;
    if (isAttack) {
      const targetX = Math.max(0, Math.min(settings.gridSize - 1, bot.x + (Math.floor(Math.random() * 5) - 2)));
      const targetY = Math.max(0, Math.min(settings.gridSize - 1, bot.y + (Math.floor(Math.random() * 5) - 2)));
      bot.action = { type: 'attack', targetX, targetY };
    } else {
      const dx = Math.floor(Math.random() * 3) - 1;
      const dy = Math.floor(Math.random() * 3) - 1;
      const newX = Math.max(0, Math.min(settings.gridSize - 1, bot.x + dx));
      const newY = Math.max(0, Math.min(settings.gridSize - 1, bot.y + dy));
      bot.action = { type: 'move', x: newX, y: newY };
    }
  });
}

function resolveTurn() {
  let logs = [];
  const alivePlayers = Object.values(players).filter(p => p.alive);
  const center = Math.floor(settings.gridSize / 2);

  logs.push(`--- ターン ${currentTurn} 解決 ---`);

  alivePlayers.forEach(p => {
    if (p.action && p.action.type === 'move') {
      const { x, y } = p.action;
      const currentCell = mapObjects[`${p.x},${p.y}`];
      const targetCell = mapObjects[`${x},${y}`];
      
      const currentElevation = currentCell ? currentCell.elevation : 1;
      const targetElevation = targetCell ? targetCell.elevation : 1;
      
      const elevationDiff = Math.abs(currentElevation - targetElevation);
      const maxMove = currentElevation >= 2 ? 2 : 1;
      const dist = Math.abs(p.x - x) + Math.abs(p.y - y);

      if (elevationDiff < 2 && dist <= maxMove && x >= 0 && x < settings.gridSize && y >= 0 && y < settings.gridSize) {
        p.x = x;
        p.y = y;
        logs.push(`${p.name} が (${x}, ${y}) に移動した`);

        const key = `${x},${y}`;
        if (mapObjects[key] && mapObjects[key].type === 'treasure' && !mapObjects[key].opened) {
          mapObjects[key].opened = true;
          p.ammo += 3;
          logs.push(`✨ ${p.name} が宝箱を発見！弾薬+3獲得！`);
        }
      } else {
        logs.push(`${p.name} の移動先は高低差が激しすぎるか遠すぎます`);
      }
    }
  });

  alivePlayers.forEach(p => {
    if (p.action && p.action.type === 'attack') {
      if (p.ammo <= 0) {
        logs.push(`${p.name} は弾切れで攻撃できなかった！`);
        return;
      }
      p.ammo--;
      const { targetX, targetY } = p.action;
      
      const attackerCell = mapObjects[`${p.x},${p.y}`];
      const targetCell = mapObjects[`${targetX},${targetY}`];
      const attackerElevation = attackerCell ? attackerCell.elevation : 1;
      const targetElevation = targetCell ? targetCell.elevation : 1;

      let maxRange = 3;
      if (attackerElevation > targetElevation) maxRange += (attackerElevation - targetElevation);
      if (attackerElevation < targetElevation) maxRange -= (targetElevation - attackerElevation);

      const dist = Math.max(Math.abs(p.x - targetX), Math.abs(p.y - targetY));

      if (dist <= Math.max(1, maxRange) && targetX >= 0 && targetX < settings.gridSize && targetY >= 0 && targetY < settings.gridSize) {
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
      } else {
        logs.push(`${p.name} の砲撃は射程外だった...`);
      }
    }
  });

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

  Object.values(players).forEach(p => { p.action = null; });
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
  io.emit('updateState', { players, gameState, settings, safeZoneRadius, hostSocketId });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`サーバー起動: ポート ${PORT}`);
});
