const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// CORSの許可設定（GitHub Pagesからのアクセスを許可）
app.use(cors({
  origin: "https://kimuchi1224.github.io",
  methods: ["GET", "POST"]
}));

const server = http.createServer(app);
// Socket.IO側でもCORSを許可
const io = new Server(server, {
  cors: {
    origin: "https://kimuchi1224.github.io",
    methods: ["GET", "POST"]
  }
});

app.use(express.static('public'));

const GRID_SIZE = 10; // 10x10のフィールド
let players = {}; // 接続中のプレイヤー情報
let gamePhase = 'waiting'; // 'waiting' or 'planning'

io.on('connection', (socket) => {
  console.log(`ユーザー接続: ${socket.id}`);

  // プレイヤーが参加
  players[socket.id] = {
    id: socket.id,
    x: Math.floor(Math.random() * GRID_SIZE),
    y: Math.floor(Math.random() * GRID_SIZE),
    hp: 100,
    action: null, // { type: 'move'/'attack', targetX, targetY }
    alive: true
  };

  // 全員に最新のプレイヤー状況を通知
  updateGameState();

  // プレイヤーからの行動受信
  socket.on('submitAction', (actionData) => {
    if (!players[socket.id] || !players[socket.id].alive) return;
    
    players[socket.id].action = actionData;
    console.log(`行動受信: ${socket.id}`, actionData);

    // 全生存プレイヤーが行動を選択したかチェック
    checkAllActionsSubmitted();
  });

  socket.on('disconnect', () => {
    console.log(`ユーザー切断: ${socket.id}`);
    delete players[socket.id];
    updateGameState();
  });
});

// 全員の行動が揃ったか判定し、ターンを解決する
function checkAllActionsSubmitted() {
  const alivePlayers = Object.values(players).filter(p => p.alive);
  if (alivePlayers.length === 0) return;

  const allSubmitted = alivePlayers.every(p => p.action !== null);

  if (allSubmitted) {
    resolveTurn();
  }
}

// ターン解決処理（海戦ゲームの肝）
function resolveTurn() {
  let logs = [];

  const alivePlayers = Object.values(players).filter(p => p.alive);

  // 1. 移動の処理
  alivePlayers.forEach(p => {
    if (p.action && p.action.type === 'move') {
      p.x = p.action.x;
      p.y = p.action.y;
      logs.push(`プレイヤー ${p.id.slice(0, 4)} が (${p.x}, ${p.y}) に移動した`);
    }
  });

  // 2. 攻撃の処理
  alivePlayers.forEach(p => {
    if (p.action && p.action.type === 'attack') {
      const { targetX, targetY } = p.action;
      logs.push(`プレイヤー ${p.id.slice(0, 4)} が (${targetX}, ${targetY}) を攻撃！`);

      // 攻撃座標に他のプレイヤーがいるか判定
      alivePlayers.forEach(target => {
        if (target.id !== p.id && target.x === targetX && target.y === targetY) {
          target.hp -= 30;
          logs.push(`-> 命中！ プレイヤー ${target.id.slice(0, 4)} に30ダメージ！`);
          if (target.hp <= 0) {
            target.alive = false;
            logs.push(`-> プレイヤー ${target.id.slice(0, 4)} は倒れた...`);
          }
        }
      });
    }
  });

  // 行動をリセット
  alivePlayers.forEach(p => { p.action = null; });

  // 結果を全員に送信
  io.emit('turnResult', { players, logs });
  updateGameState();
}

function updateGameState() {
  io.emit('updateState', players);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);
});
