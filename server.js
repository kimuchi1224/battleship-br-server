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
  gridSize: 14,
  botCount: 4
};
let players = {};
let mapObjects = {};
let currentTurn = 0;
let safeZoneRadius = 7;
let hostSocketId = null;

// 武器（兵装）の定義
const WEAPONS = {
  standard: { id: 'standard', name: '標準砲弾', range: 3, damage: 35, ammoCost: 1, desc: '標準的なバランス装備' },
  sniper: { id: 'sniper', name: 'スナイパー砲', range: 5, damage: 40, ammoCost: 2, desc: '超遠距離狙撃 (移動力-1)' },
  grenade: { id: 'grenade', name: 'グレネード', range: 2, damage: 25, ammoCost: 2, desc: '範囲爆破 (周囲も巻き込む)' }
};

// アイテム定義
const ITEM_TABLE = [
  { id: 'scope', name: '高倍率スコープ', type: 'passive', desc: '射程+1' },
  { id: 'armor', name: '強化装甲', type: 'passive', desc: '被ダメージ-10' },
  { id: 'smoke', name: '煙幕弾', type: 'active', desc: '【使い切り】攻撃完全回避' },
  { id: 'sonar', name: 'ソナー装置', type: 'active', desc: '【使い切り】敵の方向を探知' }
];

function generateMap(size) {
  mapObjects = {};
  safeZoneRadius = Math.floor(size / 2);

  let gridElevations = Array(size).fill(0).map(() => Array(size).fill(1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rand = Math.random();
      if (rand < 0.12) {
        gridElevations[y][x] = -1; // -1は移動不可マス（水辺・奈落）
      } else {
        gridElevations[y][x] = Math.floor(Math.random() * 4);
      }
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const key = `${x},${y}`;
      const elev = gridElevations[y][x];
      
      let objType = null;
      if (elev !== -1) {
        const r = Math.random();
        if (r < 0.12) objType = 'treasure';
        else if (r < 0.25) objType = 'grass';
      }

      mapObjects[key] = {
        elevation: elev, // -1なら通行不可
        type: objType,
        opened: false
      };
    }
  }
}

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
    maxHp: 100,
    ammo: 10,
    weapon: 'standard', // 選択中の兵装
    passives: [],
    items: [],
    isSmoking: false,
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

  socket.on('updateName', (newName) => {
    if (players[socket.id] && newName.trim() !== '') {
      players[socket.id].name = newName.trim().slice(0, 15);
      updateGameData();
    }
  });

  socket.on('updateWeapon', (weaponId) => {
    if (players[socket.id] && WEAPONS[weaponId]) {
      players[socket.id].weapon = weaponId;
      updateGameData();
    }
  });

  socket.on('updateSettings', (newSettings) => {
    if (gameState !== 'lobby' || socket.id !== hostSocketId) return;
    settings.gridSize = parseInt(newSettings.gridSize) || 14;
    settings.botCount = parseInt(newSettings.botCount) !== undefined ? parseInt(newSettings.botCount) : 4;
    io.emit('settingsUpdated', settings);
  });

  socket.on('toggleReady', () => {
    if (gameState !== 'lobby') return;
    players[socket.id].ready = !players[socket.id].ready;
    updateGameData();
  });

  socket.on('startGame', () => {
    if (gameState !== 'lobby' || socket.id !== hostSocketId) return;
    
    gameState = 'playing';
    currentTurn = 1;
    generateMap(settings.gridSize);

    for (let id in players) {
      if (players[id].isBot) delete players[id];
    }

    const weaponKeys = Object.keys(WEAPONS);
    for (let i = 1; i <= settings.botCount; i++) {
      const botId = `bot_${i}`;
      players[botId] = {
        id: botId,
        name: `🤖 Bot_${i}`,
        hp: 100,
        maxHp: 100,
        ammo: 10,
        weapon: weaponKeys[Math.floor(Math.random() * weaponKeys.length)],
        passives: [],
        items: [{ id: 'smoke', name: '煙幕弾', desc: '攻撃回避' }],
        isSmoking: false,
        action: null,
        alive: true,
        ready: true,
        isBot: true,
        x: 0,
        y: 0
      };
    }

    // 通行可能なマスに配置する
    Object.values(players).forEach((p) => {
      let rx, ry, key;
      do {
        rx = Math.floor(Math.random() * settings.gridSize);
        ry = Math.floor(Math.random() * settings.gridSize);
        key = `${rx},${ry}`;
      } while (!mapObjects[key] || mapObjects[key].elevation === -1);

      p.x = rx;
      p.y = ry;
      p.hp = 100;
      p.ammo = 10;
      p.passives = [];
      p.items = [];
      p.isSmoking = false;
      p.alive = true;
      p.action = null;
    });

    io.emit('gameStarted', { settings, mapObjects });
    updateGameData();
  });

  socket.on('forceEndGame', () => {
    if (socket.id !== hostSocketId) return;
    gameState = 'lobby';
    for (let id in players) {
      if (players[id].isBot) delete players[id];
      else { players[id].ready = false; players[id].action = null; players[id].alive = true; }
    }
    updateGameData();
  });

  socket.on('returnToLobby', () => {
    gameState = 'lobby';
    for (let id in players) {
      if (players[id].isBot) delete players[id];
      else { players[id].ready = false; players[id].action = null; players[id].alive = true; }
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
    const hasSmoke = bot.items.findIndex(i => i.id === 'smoke');
    const rand = Math.random();
    
    if (rand < 0.15 && hasSmoke !== -1) {
      bot.items.splice(hasSmoke, 1);
      bot.action = { type: 'item', itemId: 'smoke' };
    } else if (rand < 0.7 && bot.ammo > 0) {
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
  let publicLogs = [];
  const alivePlayers = Object.values(players).filter(p => p.alive);
  const center = Math.floor(settings.gridSize / 2);

  publicLogs.push(`--- ターン ${currentTurn} 解決 ---`);

  alivePlayers.forEach(p => { p.isSmoking = false; });

  // 1. アイテム使用
  alivePlayers.forEach(p => {
    if (p.action && p.action.type === 'item') {
      const itemIdx = p.items.findIndex(i => i.id === p.action.itemId);
      if (itemIdx !== -1) p.items.splice(itemIdx, 1);

      if (p.action.itemId === 'smoke') {
        p.isSmoking = true;
        publicLogs.push(`💨 どこかで煙幕が展開された！`);
      } else if (p.action.itemId === 'sonar') {
        publicLogs.push(`📡 ソナー波が検知された！`);
      }
    }
  });

  // 2. 移動判定（水辺・奈落のチェック）
  alivePlayers.forEach(p => {
    if (p.action && p.action.type === 'move') {
      const { x, y } = p.action;
      const targetCell = mapObjects[`${x},${y}`];
      
      // 移動不可マス（-1）なら移動失敗
      if (!targetCell || targetCell.elevation === -1) {
        publicLogs.push(`❌ ${!p.isBot ? p.name : '何者か'} の移動先は水辺または奈落のため阻まれた。`);
        return;
      }

      const currentCell = mapObjects[`${p.x},${p.y}`];
      const currentElevation = currentCell ? currentCell.elevation : 1;
      const targetElevation = targetCell.elevation;
      
      const elevationDiff = Math.abs(currentElevation - targetElevation);
      const wData = WEAPONS[p.weapon] || WEAPONS.standard;
      // スナイパーは移動力ペナルティ(-1)
      const maxMove = (wData.id === 'sniper') ? 1 : (currentElevation >= 2 ? 2 : 1);
      const dist = Math.abs(p.x - x) + Math.abs(p.y - y);

      if (elevationDiff < 2 && dist <= maxMove && x >= 0 && x < settings.gridSize && y >= 0 && y < settings.gridSize) {
        p.x = x;
        p.y = y;
        publicLogs.push(`🌊 水面が揺れた… (${!p.isBot ? p.name + 'が移動した' : '気配が移動した'})`);

        const key = `${x},${y}`;
        if (mapObjects[key] && mapObjects[key].type === 'treasure' && !mapObjects[key].opened) {
          mapObjects[key].opened = true;
          p.ammo += 4;
          const dropped = ITEM_TABLE[Math.floor(Math.random() * ITEM_TABLE.length)];
          if (dropped.type === 'passive') {
            if (!p.passives.some(i => i.id === dropped.id)) p.passives.push(dropped);
          } else {
            p.items.push(dropped);
          }
          publicLogs.push(`✨ どこかで宝箱が開けられた音がした！`);
        }
      } else {
        publicLogs.push(`❌ 移動に失敗した。`);
      }
    }
  });

  // 3. 攻撃判定（兵装ごとの射程・範囲・ダメージ）
  alivePlayers.forEach(p => {
    if (p.action && p.action.type === 'attack') {
      const wData = WEAPONS[p.weapon] || WEAPONS.standard;
      if (p.ammo < wData.ammoCost) {
        publicLogs.push(`⚠️ ${!p.isBot ? p.name : '何者か'} は弾薬不足で攻撃できなかった！`);
        return;
      }
      p.ammo -= wData.ammoCost;
      const { targetX, targetY } = p.action;

      const attackerCell = mapObjects[`${p.x},${p.y}`];
      const targetCell = mapObjects[`${targetX},${targetY}`];
      const attackerElevation = attackerCell ? attackerCell.elevation : 1;
      const targetElevation = targetCell && targetCell.elevation !== -1 ? targetCell.elevation : 1;

      let maxRange = wData.range;
      if (attackerElevation > targetElevation) maxRange += (attackerElevation - targetElevation);
      if (attackerElevation < targetElevation) maxRange -= (targetElevation - attackerElevation);

      const dist = Math.max(Math.abs(p.x - targetX), Math.abs(p.y - targetY));

      if (dist <= Math.max(1, maxRange) && targetX >= 0 && targetX < settings.gridSize && targetY >= 0 && targetY < settings.gridSize) {
        publicLogs.push(`💥 轟音！ (${targetX}, ${targetY}) 付近に激しい砲撃が着弾した！`);

        alivePlayers.forEach(target => {
          // グレネードなら周囲1マスも巻き込む
          const hitDist = Math.max(Math.abs(target.x - targetX), Math.abs(target.y - targetY));
          const isHit = (wData.id === 'grenade') ? hitDist <= 1 : (target.x === targetX && target.y === targetY);

          if (target.id !== p.id && isHit) {
            if (target.isSmoking) {
              publicLogs.push(`💨 煙幕により爆撃は直撃を免れた！`);
              return;
            }

            const hasArmor = target.passives.some(item => item.id === 'armor');
            const dmg = hasArmor ? Math.max(10, wData.damage - 10) : wData.damage;

            target.hp -= dmg;
            publicLogs.push(`🎯 悲鳴が響いた！ 誰かに ${dmg} の大ダメージ！`);
            if (target.hp <= 0) {
              target.alive = false;
              publicLogs.push(`💀 遠方で船が沈没する音が聞こえた…`);
            }
          }
        });
      } else {
        publicLogs.push(`💥 砲撃は虚しく海原へ外れた。`);
      }
    }
  });

  // 4. 足音（Stealth attack 手がかり）の生成
  // 各プレイヤーの周囲2マス以内に他のプレイヤーがいれば足音ログを個別生成
  let playerEvents = {};
  alivePlayers.forEach(p => {
    if (p.isBot) return;
    let nearbyNotices = [];
    alivePlayers.forEach(other => {
      if (other.id !== p.id) {
        const d = Math.max(Math.abs(p.x - other.x), Math.abs(p.y - other.y));
        if (d <= 2) {
          nearbyNotices.push(`🌊 チャプ… 近距離で水の気配（足音）がする…！`);
        }
      }
    });
    playerEvents[p.id] = { logs: [...publicLogs, ...nearbyNotices] };
  });

  // 5. 安全地帯縮小
  if (currentTurn % 3 === 0 && safeZoneRadius > 2) {
    safeZoneRadius--;
    publicLogs.push(`⚠️ 毒ガスが全域に広がり、安全地帯が縮小した！（半径: ${safeZoneRadius}）`);
  }

  alivePlayers.forEach(p => {
    const distFromCenter = Math.max(Math.abs(p.x - center), Math.abs(p.y - center));
    if (distFromCenter > safeZoneRadius) {
      p.hp -= 20;
      if (p.hp <= 0) {
        p.alive = false;
        publicLogs.push(`💀 誰かが毒ガスに飲まれて沈没した…`);
      }
    }
  });

  Object.values(players).forEach(p => { p.action = null; });
  currentTurn++;

  const remainingAlive = Object.values(players).filter(p => p.alive);
  if (remainingAlive.length <= 1) {
    gameState = 'ended';
    if (remainingAlive.length === 1) {
      publicLogs.push(`🏆 生き残った勝者: ${remainingAlive[0].name} !!!`);
    } else {
      publicLogs.push(`引き分け (全滅)`);
    }
  }

  io.emit('turnResult', { players, mapObjects, publicLogs, playerEvents, gameState, safeZoneRadius });
  updateGameData();
}

function updateGameData() {
  io.emit('updateState', { players, gameState, settings, safeZoneRadius, hostSocketId });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`サーバー起動: ポート ${PORT}`);
});
