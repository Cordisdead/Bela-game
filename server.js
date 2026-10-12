const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.json({ ok: true }));
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const SUITS = ['♣', '♦', '♥', '♠'];
const RANKS = ['9', '10', 'J', 'Q', 'K', 'A'];
const NORMAL_POINTS = { '9': 0, '10': 10, J: 2, Q: 3, K: 4, A: 11 };
const TRUMP_POINTS = { '9': 14, '10': 10, J: 20, Q: 3, K: 4, A: 11 };
const NORMAL_POWER = { '9': 0, J: 1, Q: 2, K: 3, '10': 4, A: 5 };
const TRUMP_POWER = { Q: 1, K: 2, '10': 3, A: 4, '9': 5, J: 6 };
const SEQ_POWER = { '9': 0, '10': 1, J: 2, Q: 3, K: 4, A: 5 };
const uid = () => crypto.randomBytes(5).toString('hex').toUpperCase();
const cleanName = s => String(s || 'Игрок').trim().slice(0, 18) || 'Игрок';
const team = seat => seat % 2 === 0 ? 0 : 1;
const teamName = t => t === 0 ? 'Север–Юг' : 'Восток–Запад';
const shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
function deck() { return shuffle(SUITS.flatMap(s => RANKS.map(r => ({ s, r, id: r + s })))); }
function sortHand(hand) { hand.sort((a, b) => SUITS.indexOf(a.s) - SUITS.indexOf(b.s) || RANKS.indexOf(a.r) - RANKS.indexOf(b.r)); }
function points(card, trump) { return card.s === trump ? TRUMP_POINTS[card.r] : NORMAL_POINTS[card.r]; }
function power(card, trump) { return card.s === trump ? TRUMP_POWER[card.r] + 100 : NORMAL_POWER[card.r]; }
function currentWinningCard(trick, trump) {
  let best = trick[0];
  const lead = trick[0].card.s;
  for (const play of trick.slice(1)) {
    const a = play.card, b = best.card;
    const aTrump = a.s === trump, bTrump = b.s === trump;
    if (aTrump && !bTrump) { best = play; continue; }
    if (!aTrump && bTrump) continue;
    if (aTrump && bTrump) { if (power(a, trump) > power(b, trump)) best = play; continue; }
    if (a.s === lead && b.s !== lead) { best = play; continue; }
    if (a.s === b.s && power(a, trump) > power(b, trump)) best = play;
  }
  return best;
}
function legalCards(hand, trick, trump, playingSeat) {
  if (!trick.length) return hand;
  const lead = trick[0].card.s;
  const follow = hand.filter(c => c.s === lead);
  if (follow.length) return follow;
  const trumps = hand.filter(c => c.s === trump);
  if (!trumps.length) return hand;
  const winning = currentWinningCard(trick, trump);
  const winningIsTrump = winning.card.s === trump;
  const winningTeam = team(winning.seat);
  if (winningIsTrump && winningTeam !== team(playingSeat)) {
    const stronger = trumps.filter(c => power(c, trump) > power(winning.card, trump));
    if (stronger.length) return stronger;
  }
  return trumps;
}
function findCombinations(hand) {
  const combos = [];
  // Four of a kind: J=200, 9=150, other ranks=100.
  for (const rank of RANKS) {
    const cards = hand.filter(c => c.r === rank);
    if (cards.length === 4) {
      const value = rank === 'J' ? 200 : rank === '9' ? 150 : 100;
      const comboPower = rank === 'J' ? 106 : rank === '9' ? 105 : rank === 'A' ? 104 : rank === '10' ? 103 : rank === 'K' ? 102 : 101;
      combos.push({ type: 'каре', label: `Каре ${rank}`, value, power: comboPower, suit: null });
    }
  }
  // Runs are formed separately in each suit. Aces are high; no wrap-around.
  for (const suit of SUITS) {
    const held = new Set(hand.filter(c => c.s === suit).map(c => c.r));
    let run = [];
    for (const rank of RANKS) {
      if (held.has(rank)) run.push(rank);
      else { addRun(run, suit, combos); run = []; }
    }
    addRun(run, suit, combos);
  }
  return combos;
}
function addRun(run, suit, combos) {
  if (run.length < 3) return;
  // A run of 5+ counts as one 100-point sequence; six cards still count as 100.
  const len = run.length;
  const value = len >= 5 ? 100 : len === 4 ? 50 : 20;
  combos.push({ type: 'sequence', label: `${len >= 5 ? 'Сотка' : len === 4 ? 'Полтина' : 'Терц'} ${run.join('-')} ${suit}`, value, power: len * 10 + SEQ_POWER[run[len - 1]], suit });
}
function strongestCombo(hand) {
  const combos = findCombinations(hand);
  if (!combos.length) return null;
  combos.sort((a, b) => b.power - a.power || b.value - a.value);
  return combos[0];
}
function computeAnnouncements(room) {
  const entries = room.hands.map((hand, seat) => { const combos = findCombinations(hand); const sorted = combos.slice().sort((a, b) => b.power - a.power || b.value - a.value); return { seat, team: team(seat), combo: sorted[0] || null, combos, belot: hand.some(c => c.s === room.trump && c.r === 'Q') && hand.some(c => c.s === room.trump && c.r === 'K') }; });
  const all = entries.filter(e => e.combo);
  if (!all.length) return { entries, points: [0, 0], log: [] };
  const bestPower = Math.max(...all.map(e => e.combo.power));
  const top = all.filter(e => e.combo.power === bestPower);
  const winningTeams = [...new Set(top.map(e => e.team))];
  const score = [0, 0], log = [];
  if (winningTeams.length === 1) {
    const winnerTeam = winningTeams[0];
    // Once a team wins the declarations, all of its combinations are scored.
    const wonCombos = entries.filter(e => e.team === winnerTeam).flatMap(e => e.combos);
    for (const combo of wonCombos) score[winnerTeam] += combo.value;
    if (wonCombos.length) log.push(`${teamName(winnerTeam)}: ${wonCombos.map(c => `${c.label} (+${c.value})`).join(', ')}`);
  } else log.push('Равные старшие комбинации — очки за комбинации не начислены.');
  entries.filter(e => e.belot).forEach(e => { score[e.team] += 20; log.push(`${teamName(e.team)}: белот (+20)`); });
  return { entries, points: score, log };
}
function rounded5(n) { return Math.round(n / 5) * 5; }
function roomView(room, socketId) {
  const me = room.players.findIndex(p => p.id === socketId);
  return {
    code: room.code, host: room.host, phase: room.phase, target: room.target,
    players: room.players.map((p, i) => ({ seat: i, name: p.name, team: team(i), connected: !!io.sockets.sockets.get(p.id), isMe: i === me })),
    me, teamScores: room.teamScores, roundScores: room.roundScores, dealer: room.dealer,
    turn: room.turn, trump: room.trump, trick: room.trick.map(t => ({ seat: t.seat, card: t.card })),
    trickNo: room.trickNo, tricksWon: room.tricksWon, hand: me >= 0 && room.hands ? room.hands[me] : [],
    lastMessage: room.lastMessage, lastTrick: room.lastTrick, roundSummary: room.roundSummary,
    announcements: room.phase === 'roundEnd' || room.phase === 'finished' ? room.announcementLog : []
  };
}
function broadcast(room) { room.players.forEach(p => io.to(p.id).emit('state', roomView(room, p.id))); }
function message(room, text) { room.lastMessage = text; }
function makeRoom(name, socket) {
  const code = uid().slice(0, 5);
  const room = { code, host: socket.id, players: [{ id: socket.id, name }], phase: 'lobby', target: 1000,
    dealer: 0, turn: 0, trump: null, hands: null, trick: [], trickNo: 0, tricksWon: [0, 0],
    teamScores: [0, 0], roundScores: [0, 0], lastMessage: 'Ждём ещё трёх игроков.', lastTrick: null,
    roundSummary: null, announcementLog: [], _completedTricks: [] };
  rooms.set(code, room); socket.join(code); return room;
}
function startRound(room) {
  const cards = deck();
  room.hands = [[], [], [], []];
  for (let i = 0; i < 24; i++) room.hands[(room.dealer + 1 + i) % 4].push(cards[i]);
  room.hands.forEach(sortHand);
  room.trump = SUITS[Math.floor(Math.random() * SUITS.length)];
  room.phase = 'playing'; room.trick = []; room.trickNo = 0; room.tricksWon = [0, 0]; room.roundScores = [0, 0];
  room.lastTrick = null; room.roundSummary = null; room._completedTricks = []; room.announcementLog = [];
  room.turn = (room.dealer + 1) % 4;
  room._announcements = computeAnnouncements(room);
  message(room, `Козырь ${room.trump}. ${room.players[room.turn].name} ходит первым.`);
}
function scoreRound(room) {
  const raw = [0, 0];
  room._completedTricks.forEach((t, index) => {
    for (const c of t.cards) raw[team(c.seat)] += points(c.card, room.trump);
    if (index === room._completedTricks.length - 1) raw[team(t.winner)] += 10;
  });
  const announcements = room._announcements || { points: [0, 0], log: [] };
  raw[0] += announcements.points[0]; raw[1] += announcements.points[1];
  const rounded = raw.map(rounded5);
  room.roundScores = rounded;
  room.teamScores = [room.teamScores[0] + rounded[0], room.teamScores[1] + rounded[1]];
  room.announcementLog = announcements.log;
  room.roundSummary = { raw, rounded, teamScores: room.teamScores.slice(), trump: room.trump, tricksWon: room.tricksWon.slice(), announcements: announcements.log };
  room.phase = room.teamScores.some(s => s >= room.target) ? 'finished' : 'roundEnd';
  const winner = room.teamScores[0] === room.teamScores[1] ? null : (room.teamScores[0] > room.teamScores[1] ? 0 : 1);
  message(room, room.phase === 'finished' ? (winner === null ? 'Матч завершён вничью!' : `Матч выиграла команда ${teamName(winner)}!`) : 'Раздача завершена. Нажмите «Следующая раздача».');
}
function completeTrick(room) {
  const winning = currentWinningCard(room.trick, room.trump);
  const winner = winning.seat, cards = room.trick.slice();
  room.tricksWon[team(winner)]++;
  room.lastTrick = { winner, cards };
  room._completedTricks.push({ winner, cards });
  room.trick = []; room.trickNo++;
  if (room.trickNo === 6) { scoreRound(room); return; }
  room.turn = winner; message(room, `${room.players[winner].name} забирает взятку.`);
}
io.on('connection', socket => {
  socket.on('createRoom', ({ name }, cb = () => {}) => { const room = makeRoom(cleanName(name), socket); cb({ ok: true, code: room.code }); broadcast(room); });
  socket.on('joinRoom', ({ code, name }, cb = () => {}) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return cb({ ok: false, error: 'Комната не найдена.' });
    if (room.phase !== 'lobby') return cb({ ok: false, error: 'Игра уже началась.' });
    if (room.players.length >= 4) return cb({ ok: false, error: 'Комната заполнена.' });
    if (room.players.some(p => p.name.toLowerCase() === cleanName(name).toLowerCase())) return cb({ ok: false, error: 'Имя уже занято в комнате.' });
    room.players.push({ id: socket.id, name: cleanName(name) }); socket.join(room.code);
    message(room, room.players.length === 4 ? 'Все на месте — можно начинать!' : 'Подключился новый игрок.');
    cb({ ok: true, code: room.code }); broadcast(room);
  });
  socket.on('startGame', (_, cb = () => {}) => {
    const room = [...rooms.values()].find(r => r.host === socket.id);
    if (!room) return cb({ ok: false, error: 'Только создатель комнаты может начать.' });
    if (room.players.length !== 4) return cb({ ok: false, error: 'Нужно ровно 4 игрока.' });
    room.target = 1000; room.teamScores = [0, 0]; room.dealer = 0; startRound(room); cb({ ok: true }); broadcast(room);
  });
  socket.on('playCard', ({ cardId }, cb = () => {}) => {
    const room = [...rooms.values()].find(r => r.players.some(p => p.id === socket.id));
    if (!room || room.phase !== 'playing' || room.players[room.turn]?.id !== socket.id) return cb({ ok: false, error: 'Сейчас не ваш ход.' });
    const seat = room.players.findIndex(p => p.id === socket.id), hand = room.hands[seat];
    const card = hand.find(c => c.id === cardId);
    if (!card) return cb({ ok: false, error: 'Этой карты нет в вашей руке.' });
    const legal = legalCards(hand, room.trick, room.trump, seat);
    if (!legal.some(c => c.id === cardId)) return cb({ ok: false, error: 'Нужно следовать масти, козырять или перебить козырь, если возможно.' });
    hand.splice(hand.findIndex(c => c.id === cardId), 1); room.trick.push({ seat, card });
    if (room.trick.length === 4) completeTrick(room);
    else { room.turn = (room.turn + 1) % 4; message(room, `${room.players[room.turn].name}, ваш ход.`); }
    cb({ ok: true }); broadcast(room);
  });
  socket.on('nextRound', (_, cb = () => {}) => {
    const room = [...rooms.values()].find(r => r.players.some(p => p.id === socket.id));
    if (!room || room.host !== socket.id) return cb({ ok: false, error: 'Только создатель комнаты.' });
    if (room.phase !== 'roundEnd') return cb({ ok: false, error: 'Сейчас нельзя начать следующую раздачу.' });
    room.dealer = (room.dealer + 1) % 4; startRound(room); cb({ ok: true }); broadcast(room);
  });
  socket.on('disconnect', () => {
    for (const room of rooms.values()) { const p = room.players.find(p => p.id === socket.id); if (p) { message(room, `${p.name} отключился. Можно обновить страницу и войти снова в новую комнату.`); broadcast(room); } }
  });
});
server.listen(PORT, () => console.log(`Belot Friends running on ${PORT}`));
