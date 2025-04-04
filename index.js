// server/index.js
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { db } = require("./db"); // Firestore 用モジュール
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
app.use(cors());

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ルーム情報をまとめて管理
// rooms[roomId] = {
//   players: [...],
//   deck: [...],                 // フォルダ内の画像ファイル名リスト
//   currentTurnPlayerIndex: 0,
//   onomatopoeiaList: [...],     // [{ onomatopoeia: string, playerIds: [id, id, ...] }]
//   deckName: "...",
//   currentCard: null | string,
//   roundCount: number,
//   stats: {                     // オノマトペ使用頻度
//     [socketId]: { [word]: number, ... }
//   }
// }
const rooms = {};

io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);

  /** -----------------------------------------
   *  部屋作成イベント
   * ----------------------------------------*/
  socket.on('createRoom', ({ roomId, playerName, deckName }) => {
    if (rooms[roomId]) {
      socket.emit('error', 'Room already exists');
      return;
    }

    try {
      // public/images/[deckName] フォルダ内の画像ファイルを読み込み
      const deckFolder = path.join(__dirname, '..', 'public', 'images', deckName);
      // 画像ファイルのみ抽出
      let allCards = fs.readdirSync(deckFolder).filter(file =>
        /\.(jpg|jpeg|png|gif)$/i.test(file)
      );

      // シャッフル(Fisher-Yates)
      for (let i = allCards.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allCards[i], allCards[j]] = [allCards[j], allCards[i]];
      }

      // ルーム初期化
      rooms[roomId] = {
        players: [{ id: socket.id, name: playerName, points: 0 }],
        deck: allCards,
        currentTurnPlayerIndex: 0,
        onomatopoeiaList: [],
        deckName,
        currentCard: null,
        roundCount: 1,
        stats: {}, // オノマトペ使用頻度の集計
      };

      socket.join(roomId);
      io.emit('roomsList', Object.keys(rooms));
      io.to(roomId).emit('updatePlayers', rooms[roomId].players);

    } catch (error) {
      console.error("デッキ読み込みエラー:", error);
      socket.emit('error', 'Failed to load deck images');
    }
  });

  /** -----------------------------------------
   *  部屋参加イベント
   * ----------------------------------------*/
  socket.on('joinRoom', ({ roomId, playerName }) => {
    if (!rooms[roomId]) {
      socket.emit('error', 'Room does not exist');
      return;
    }
    if (rooms[roomId].players.some(p => p.name === playerName)) {
      socket.emit('error', 'Name already taken in this room');
      return;
    }

    rooms[roomId].players.push({ id: socket.id, name: playerName, points: 0 });
    socket.join(roomId);
    io.to(roomId).emit('updatePlayers', rooms[roomId].players);
  });

  /** -----------------------------------------
   *  ゲーム開始イベント
   * ----------------------------------------*/
  socket.on('startGame', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;

    // 親をランダムに決定
    room.currentTurnPlayerIndex = Math.floor(Math.random() * room.players.length);

    // デッキ名だけ送る（フロント表示用など）
    io.to(roomId).emit('updateRoomInfo', { deckName: room.deckName });

    // ゲーム開始を通知
    io.to(roomId).emit('gameStarted', room.players[room.currentTurnPlayerIndex]);
  });

  /** -----------------------------------------
   *  カードを引く（親だけ）
   * ----------------------------------------*/
  socket.on('drawCard', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;

    const currentPlayer = room.players[room.currentTurnPlayerIndex];
    if (socket.id !== currentPlayer.id) return;

    // deck が空の場合にも対応
    const card = room.deck.length > 0 ? room.deck.pop() : null;
    if (!card) {
      endGame(roomId);
      return;
    }

    room.currentCard = card;
    io.to(roomId).emit('cardDrawn', card);
  });

  /** -----------------------------------------
   *  子プレイヤーがオノマトペ送信
   * ----------------------------------------*/
  socket.on('submitOnomatopoeia', (roomId, onomatopoeia, playerName) => {
    const room = rooms[roomId];
    if (!room) {
      console.log(`Room(${roomId}) not found.`);
      return;
    }

    // statsに使用頻度を登録
    if (!room.stats[socket.id]) {
      room.stats[socket.id] = {};
    }
    room.stats[socket.id][onomatopoeia] = (room.stats[socket.id][onomatopoeia] || 0) + 1;

    // 同じワードが既にあるかチェック
    const group = room.onomatopoeiaList.find(g => g.onomatopoeia === onomatopoeia);
    if (group) {
      if (!group.playerIds.includes(socket.id)) {
        group.playerIds.push(socket.id);
      }
    } else {
      room.onomatopoeiaList.push({ onomatopoeia, playerIds: [socket.id] });
    }

    // Firestore にログを残す
    const docData = {
      roomId,
      round: room.roundCount,
      cardName: room.currentCard,
      onomatopoeia,
      playerId: socket.id,
      playerName,
      timestamp: new Date().toISOString(),
    };
    db.collection("answers").add(docData)
      .then(() => console.log("Firestore save successful:", docData))
      .catch(err => console.error("Firestore save failed:", err));

    // 全子プレイヤーが提出終了？
    const totalSubmissions = room.onomatopoeiaList.reduce(
      (sum, g) => sum + g.playerIds.length,
      0
    );
    const expectedCount = room.players.length - 1;
    if (totalSubmissions === expectedCount) {
      const parentPlayer = room.players[room.currentTurnPlayerIndex];
      if (io.sockets.sockets.has(parentPlayer.id)) {
        io.to(parentPlayer.id).emit('onomatopoeiaList', room.onomatopoeiaList);
      }
    }
  });

  /** -----------------------------------------
   *  親プレイヤーがオノマトペを選択
   * ----------------------------------------*/
  socket.on('chooseOnomatopoeia', (roomId, selectedOnomatopoeia) => {
    const room = rooms[roomId];
    if (!room) return;

    const group = room.onomatopoeiaList.find(
      (item) => item.onomatopoeia === selectedOnomatopoeia
    );
    let chosenNames = [];
    if (group) {
      group.playerIds.forEach(playerId => {
        const player = room.players.find(p => p.id === playerId);
        if (player) {
          player.points += 1;
          chosenNames.push(player.name);
        }
      });
    }

    const parentPlayer = room.players[room.currentTurnPlayerIndex];
    const choiceData = {
      eventType: "choice",
      roomId,
      round: room.roundCount,
      parentId: parentPlayer.id,
      parentName: parentPlayer.name,
      chosenOnomatopoeia: selectedOnomatopoeia,
      chosenPlayers: chosenNames,
      cardName: room.currentCard,
      timestamp: new Date().toISOString(),
    };

    // 選択情報を Firestore に保存
    db.collection("answers").add(choiceData)
      .then(() => console.log("Firestore choice save successful:", choiceData))
      .catch(err => console.error("Firestore choice save failed:", err))
      .finally(() => {
        // 該当オノマトペを選んだ子プレイヤーにポイント加算済み → 全体へ反映
        io.to(roomId).emit('onomatopoeiaChosen', {
          chosenPlayers: chosenNames,
          updatedPlayers: room.players,
        });
        // オノマトペリストをリセット
        room.onomatopoeiaList = [];

        // カードがなくなったらゲーム終了
        if (room.deck.length === 0) {
          endGame(roomId);
          return;
        }

        // 次の親へ
        room.currentTurnPlayerIndex =
          (room.currentTurnPlayerIndex + 1) % room.players.length;
        room.roundCount++;
        io.to(roomId).emit('newTurn', room.players[room.currentTurnPlayerIndex]);
      });
  });

  /** -----------------------------------------
   *  強制次ターン
   * ----------------------------------------*/
  socket.on('nextTurn', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;

    // オノマトペリストをリセットして次へ
    room.onomatopoeiaList = [];
    room.currentTurnPlayerIndex =
      (room.currentTurnPlayerIndex + 1) % room.players.length;
    room.roundCount++;
    io.to(roomId).emit('newTurn', room.players[room.currentTurnPlayerIndex]);
  });

  /** -----------------------------------------
   *  ルーム一覧リクエスト
   * ----------------------------------------*/
  socket.on('getRooms', () => {
    socket.emit('roomsList', Object.keys(rooms));
  });

  /** -----------------------------------------
   *  切断処理
   * ----------------------------------------*/
  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(roomId => {
      rooms[roomId].players = rooms[roomId].players.filter(
        p => p.id !== socket.id
      );
      if (rooms[roomId].players.length === 0) {
        delete rooms[roomId];
        io.emit('roomsList', Object.keys(rooms));
      } else {
        io.to(roomId).emit('updatePlayers', rooms[roomId].players);
      }
    });
    console.log(`Client disconnected: ${socket.id}`);
  });

  /** -----------------------------------------
   *  ゲーム終了処理
   * ----------------------------------------*/
  function endGame(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const finalPlayers = [...room.players];
    const maxPoints = Math.max(...finalPlayers.map(p => p.points));
    const winners = finalPlayers.filter(p => p.points === maxPoints);

    // オノマトペ使用頻度トップを算出
    const usageStats = {};
    finalPlayers.forEach(player => {
      const usage = room.stats[player.id] || {};
      let topWord = null;
      let topCount = 0;
      Object.entries(usage).forEach(([word, count]) => {
        if (count > topCount) {
          topCount = count;
          topWord = word;
        }
      });
      usageStats[player.id] = { topWord, topCount };
    });

    // 全員にゲーム終了を通知
    io.to(roomId).emit('gameOver', {
      winners,
      players: finalPlayers,
      usageStats,
    });

    // ここで部屋のデータを削除してしまう場合
    delete rooms[roomId];
  }
});

// サーバー起動
const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
