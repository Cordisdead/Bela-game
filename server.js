const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_, res) => res.json({ ok: true }));
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const SUITS = ["♣", "♦", "♥", "♠"];
const RANKS = ["7", "8", "9", "10", "J", "Q", "K", "A"];
const ORDER = { "7":0, "8":1, "9":2, "10":3, "J":4, "Q":5, "K":6, "A":7 };
const VALUE = {
  normal: {"7":0,"8":0,"9":0,"10":10,"J":2,"Q":3,"K":4,"A":11},
  trump: {"7":0,"8":0,"9":14,"10":10,"J":20,"Q":3,"K":4,"A":11}
};
const uid = () => crypto.randomBytes(5).toString("hex").toUpperCase();
const cleanName = s => String(s || "Игрок").trim().slice(0,18) || "Игрок";
function roomView(room, socketId) {
  const me = room.players.findIndex(p => p.id === socketId);
  return {
    code: room.code, host: room.host, phase: room.phase, target: room.target,
    players: room.players.map((p,i)=>({seat:i,name:p.name,team:i%2===0?0:1,connected:!!io.sockets.sockets.get(p.id),isMe:i===me})),
    me, teamScores: room.teamScores, roundScores: room.roundScores,
    dealer: room.dealer, turn: room.turn, contract: room.contract,
    auction: room.auction, trick: room.trick.map(t=>({seat:t.seat,card:t.card})),
    trickNo: room.trickNo, tricksWon: room.tricksWon,
    hand: me >= 0 && room.hands ? room.hands[me] : [],
    lastMessage: room.lastMessage, lastTrick: room.lastTrick,
    roundSummary: room.roundSummary
  };
}
function broadcast(room) {
  room.players.forEach(p => io.to(p.id).emit("state", roomView(room,p.id)));
}
function message(room, text) { room.lastMessage=text; }
function makeRoom(name, socket) {
  const code=uid().slice(0,5);
  const room={code,host:socket.id,players:[{id:socket.id,name}],phase:"lobby",target:1000,
    dealer:0,turn:0,contract:null,auction:[],hands:null,trick:[],trickNo:0,
    tricksWon:[0,0],teamScores:[0,0],roundScores:[0,0],lastMessage:"Ждём ещё трёх игроков.",
    lastTrick:null,roundSummary:null};
  rooms.set(code,room); socket.join(code); return room;
}
function deck() {
  return SUITS.flatMap(s=>RANKS.map(r=>({s,r,id:r+s}))).sort(()=>Math.random()-0.5);
}
function team(seat){ return seat%2===0?0:1; }
function startRound(room) {
  room.hands=[[],[],[],[]]; const cards=deck();
  for(let i=0;i<32;i++) room.hands[(room.dealer+1+i)%4].push(cards[i]);
  room.hands.forEach(h=>h.sort((a,b)=>SUITS.indexOf(a.s)-SUITS.indexOf(b.s)||ORDER[a.r]-ORDER[b.r]));
  room.phase="auction"; room.contract=null; room.auction=[]; room.trick=[]; room.trickNo=0;
  room.tricksWon=[0,0]; room.roundScores=[0,0]; room.lastTrick=null; room.roundSummary=null;
  room.turn=(room.dealer+1)%4; message(room,`${room.players[room.turn].name} начинает торговлю.`);
}
function contractValue(c) { return Number(c.level); }
function finishAuction(room) {
  const bids=room.auction.filter(a=>a.type==="bid");
  if(!bids.length){ room.auction=[]; room.turn=(room.dealer+1)%4; message(room,"Все спасовали — раздаём заново."); setTimeout(()=>{if(rooms.get(room.code)===room&&room.phase==="auction"&&room.auction.length===0) {startRound(room);broadcast(room);}},900); return; }
  const bid=bids[bids.length-1];
  room.contract={...bid,seat:bid.seat}; room.phase="playing";
  // Declarer leads first trick in this implementation.
  room.turn=bid.seat; message(room,`${room.players[bid.seat].name} играет контракт ${bid.level} ${bid.modeLabel}.`);
}
function legalCards(hand, trick, mode) {
  if(!trick.length) return hand;
  const lead=trick[0].card.s;
  const hasLead=hand.some(c=>c.s===lead);
  if(hasLead) return hand.filter(c=>c.s===lead);
  const trump=mode==="alltrump" || (mode!=="notrump" && SUITS.includes(mode));
  if(!trump) return hand;
  const trumps=hand.filter(c=>c.s===mode || mode==="alltrump");
  if(!trumps.length) return hand;
  // In all-trump, every suit is trump; otherwise players must trump when void in lead suit.
  if(mode==="alltrump") return hand;
  return trumps;
}
function strength(card, mode, leadSuit) {
  const trump = mode==="alltrump" || card.s===mode;
  const isNoTrump=mode==="notrump";
  const rankOrder= trump ? {"7":0,"8":1,"Q":2,"K":3,"10":4,"A":5,"9":6,"J":7} : {"7":0,"8":1,"9":2,"J":3,"Q":4,"K":5,"10":6,"A":7};
  let val=rankOrder[card.r];
  if(isNoTrump || (mode!=="alltrump" && card.s!==mode)) val=ORDER[card.r];
  return (card.s===leadSuit?100:0)+(trump?200:0)+val;
}
function cardPoints(card, mode) {
  if(mode==="alltrump") return {"7":0,"8":0,"9":9,"10":10,"J":20,"Q":3,"K":4,"A":11}[card.r];
  if(mode==="notrump") return {"7":0,"8":0,"9":0,"10":10,"J":2,"Q":3,"K":4,"A":11}[card.r];
  return card.s===mode?VALUE.trump[card.r]:VALUE.normal[card.r];
}
function scoreRound(room) {
  const mode=room.contract.mode;
  const raw=[0,0];
  const completed=room._completedTricks||[];
  completed.forEach((t,index)=>{
    const winner=t.winner;
    for(const c of t.cards) raw[team(c.seat)]+=cardPoints(c.card,mode);
    if(index===completed.length-1) raw[team(winner)]+=10; // last trick only
  });
  // Bulgarian bridge-belote commonly scores card points and contract success; scale for a 1000-point match.
  const declarerTeam=team(room.contract.seat);
  const contract=contractValue(room.contract);
  const won=raw[declarerTeam]>=contract;
  if(!won){ raw[1-declarerTeam]+=raw[declarerTeam]+contract; raw[declarerTeam]=0; }
  room.roundScores=raw;
  room.teamScores=[room.teamScores[0]+raw[0],room.teamScores[1]+raw[1]];
  room.roundSummary={contract:room.contract,raw,won,declarerTeam,teamScores:room.teamScores.slice()};
  room.phase=room.teamScores.some(s=>s>=room.target)?"finished":"roundEnd";
  message(room,room.phase==="finished"?(room.teamScores[0]>room.teamScores[1]?"Команда Север–Юг победила!":"Команда Восток–Запад победила!"):"Раздача завершена. Нажмите «Следующая раздача».");
}
function completeTrick(room) {
  const mode=room.contract.mode, lead=room.trick[0].card.s;
  const ranked=room.trick.map(t=>({...t,power:strength(t.card,mode,lead)})).sort((a,b)=>b.power-a.power);
  const winner=ranked[0].seat, cards=room.trick.slice();
  room.tricksWon[team(winner)]++;
  room.lastTrick={winner,cards};
  room._completedTricks=room._completedTricks||[]; room._completedTricks.push({winner,cards});
  room.trick=[]; room.trickNo++;
  if(room.trickNo===8){scoreRound(room);room._completedTricks=[];return;}
  room.turn=winner; message(room,`${room.players[winner].name} забирает взятку.`);
}
io.on("connection", socket => {
  socket.on("createRoom", ({name}, cb=()=>{}) => {
    const room=makeRoom(cleanName(name),socket); cb({ok:true,code:room.code}); broadcast(room);
  });
  socket.on("joinRoom", ({code,name}, cb=()=>{}) => {
    const room=rooms.get(String(code||"").trim().toUpperCase());
    if(!room) return cb({ok:false,error:"Комната не найдена."});
    if(room.phase!=="lobby") return cb({ok:false,error:"Игра уже началась."});
    if(room.players.length>=4) return cb({ok:false,error:"Комната заполнена."});
    if(room.players.some(p=>p.name.toLowerCase()===cleanName(name).toLowerCase())) return cb({ok:false,error:"Имя уже занято в комнате."});
    room.players.push({id:socket.id,name:cleanName(name)}); socket.join(room.code);
    message(room,room.players.length===4?"Все на месте — можно начинать!":"Подключился новый игрок.");
    cb({ok:true,code:room.code}); broadcast(room);
  });
  socket.on("startGame", (_, cb=()=>{}) => {
    const room=[...rooms.values()].find(r=>r.host===socket.id);
    if(!room) return cb({ok:false,error:"Только создатель комнаты может начать."});
    if(room.players.length!==4) return cb({ok:false,error:"Нужно ровно 4 игрока."});
    room.target=1000; room.teamScores=[0,0]; room.dealer=0; startRound(room); room._completedTricks=[]; cb({ok:true}); broadcast(room);
  });
  socket.on("bid", ({type,level,mode}, cb=()=>{}) => {
    const room=[...rooms.values()].find(r=>r.players.some(p=>p.id===socket.id));
    if(!room||room.phase!=="auction"||room.players[room.turn]?.id!==socket.id) return cb({ok:false,error:"Сейчас не ваш ход."});
    if(type==="bid") {
      if(![80,90,100,110,120,130,140,150,160].includes(Number(level))||!["♣","♦","♥","♠","notrump","alltrump"].includes(mode)) return cb({ok:false,error:"Некорректная ставка."});
      const prior=room.auction.filter(a=>a.type==="bid").slice(-1)[0];
      if(prior && contractValue({level:Number(level),mode})<=contractValue(prior)) return cb({ok:false,error:"Новая ставка должна быть выше предыдущей."});
      const modeLabel=mode==="notrump"?"без козыря":mode==="alltrump"?"всё козыри":mode;
      room.auction.push({type:"bid",level:Number(level),mode,modeLabel,seat:room.players.findIndex(p=>p.id===socket.id)});
      message(room,`${room.players[room.turn].name}: ${level} ${modeLabel}`);
    } else if(type==="pass") {
      room.auction.push({type:"pass",seat:room.players.findIndex(p=>p.id===socket.id)});
      message(room,`${room.players[room.turn].name} пасует.`);
    } else return cb({ok:false,error:"Неизвестное действие."});
    const bids=room.auction.filter(a=>a.type==="bid"), passes=room.auction.filter(a=>a.type==="pass");
    if((bids.length===0&&passes.length===4)||(bids.length>0&&passes.length>=3&&room.auction[room.auction.length-1].type==="pass")) finishAuction(room);
    else room.turn=(room.turn+1)%4;
    cb({ok:true}); broadcast(room);
  });
  socket.on("playCard", ({cardId}, cb=()=>{}) => {
    const room=[...rooms.values()].find(r=>r.players.some(p=>p.id===socket.id));
    if(!room||room.phase!=="playing"||room.players[room.turn]?.id!==socket.id) return cb({ok:false,error:"Сейчас не ваш ход."});
    const seat=room.players.findIndex(p=>p.id===socket.id), hand=room.hands[seat];
    const card=hand.find(c=>c.id===cardId);
    if(!card) return cb({ok:false,error:"Этой карты нет в вашей руке."});
    const legal=legalCards(hand,room.trick,room.contract.mode);
    if(!legal.some(c=>c.id===cardId)) return cb({ok:false,error:"Нужно положить карту требуемой масти."});
    hand.splice(hand.findIndex(c=>c.id===cardId),1); room.trick.push({seat,card});
    if(room.trick.length===4) completeTrick(room);
    else {room.turn=(room.turn+1)%4; message(room,`${room.players[room.turn].name}, ваш ход.`);}
    cb({ok:true}); broadcast(room);
  });
  socket.on("nextRound", (_,cb=()=>{}) => {
    const room=[...rooms.values()].find(r=>r.players.some(p=>p.id===socket.id));
    if(!room||room.host!==socket.id) return cb({ok:false,error:"Только создатель комнаты."});
    if(room.phase!=="roundEnd") return cb({ok:false,error:"Сейчас нельзя начать следующую раздачу."});
    room.dealer=(room.dealer+1)%4; startRound(room); room._completedTricks=[]; cb({ok:true}); broadcast(room);
  });
  socket.on("disconnect", () => {
    for(const room of rooms.values()) {
      const p=room.players.find(p=>p.id===socket.id);
      if(p){ message(room,`${p.name} отключился. Можно обновить страницу и войти снова в новую комнату.`); broadcast(room); }
    }
  });
});
server.listen(PORT,()=>console.log(`Belot Friends running on ${PORT}`));