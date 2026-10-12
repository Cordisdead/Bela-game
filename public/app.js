const socket=io();
const $=id=>document.getElementById(id);
let state=null, myCode=null, toastTimer=null;
function toast(msg){$('toast').textContent=msg;$('toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),2800)}
function err(msg,where='lobbyError'){ $(where).textContent=msg||''; }
function act(event,payload={}){return new Promise(resolve=>socket.emit(event,payload,r=>{if(r&&!r.ok)toast(r.error);resolve(r)}))}
function name(){return $('playerName').value.trim()||'Игрок'}
$('createBtn').onclick=async()=>{err('');const r=await act('createRoom',{name:name()});if(r?.ok)myCode=r.code};
$('joinBtn').onclick=async()=>{err('');const code=$('roomCode').value.trim().toUpperCase();if(!code)return err('Введи код комнаты.');const r=await act('joinRoom',{name:name(),code});if(r?.ok)myCode=r.code;else err(r?.error||'Не удалось войти.')};
$('roomCode').addEventListener('input',e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''));
$('copyBtn').onclick=async()=>{try{await navigator.clipboard.writeText($('roomCodeTitle').textContent);toast('Код комнаты скопирован')}catch{toast('Код комнаты: '+$('roomCodeTitle').textContent)}};
$('startBtn').onclick=()=>act('startGame');
$('nextRoundBtn').onclick=()=>act('nextRound');
socket.on('connect',()=>{$('onlineDot').classList.add('on');$('connection').textContent='На связи'});
socket.on('disconnect',()=>{$('onlineDot').classList.remove('on');$('connection').textContent='Нет соединения'});
socket.on('state',s=>{state=s;myCode=s.code;render(s)});
function cardHTML(c,disabled=false){const red=c.s==='♥'||c.s==='♦';return `<button class="hand-card ${red?'red':''}" data-card="${c.id}" ${disabled?'disabled':''}><span>${c.r}</span><span class="center-suit">${c.s}</span><span class="bottom-rank">${c.r}</span></button>`}
function render(s){
 $('lobbyScreen').classList.add('hidden');$('roomScreen').classList.remove('hidden');$('roomCodeTitle').textContent=s.code;
 const names=['Север','Восток','Юг','Запад'];
 $('seats').innerHTML=Array.from({length:4},(_,i)=>{const p=s.players[i];return `<div class="seat-card ${p?'':'empty'}"><div class="avatar">${p?escapeHTML(p.name[0].toUpperCase()):'＋'}</div><div><div class="seat-name">${p?escapeHTML(p.name):'Ожидаем игрока…'}</div><small>${p?(p.isMe?'Вы · ':'')+names[i]+' · '+(i%2===0?'Команда A':'Команда B'):'Место '+(i+1)}</small></div></div>`}).join('');
 $('roomMessage').textContent=s.lastMessage||'';$('startBtn').classList.toggle('hidden',!(s.host===socket.id&&s.players.length===4&&s.phase==='lobby'));
 $('lobbyRoom').classList.toggle('hidden',s.phase!=='lobby');$('gameArea').classList.toggle('hidden',s.phase==='lobby');if(s.phase==='lobby')return;
 $('score0').textContent=s.teamScores[0];$('score1').textContent=s.teamScores[1];
 for(let seat=0;seat<4;seat++){const p=s.players[seat],el=$('seat'+seat);el.innerHTML=p?`<div class="player-pill ${s.turn===seat&&s.phase==='playing'?'active':''}"><span class="dot"></span><span>${escapeHTML(p.name)}${p.isMe?' (вы)':''}</span><span class="team-dot">${seat%2===0?'●':'◆'}</span></div>`:'';}
 $('contractBadge').textContent=s.trump?`КОЗЫРЬ ${s.trump}`:'ОЖИДАНИЕ';$('tableMessage').textContent=s.lastMessage||'';
 for(let seat=0;seat<4;seat++){const t=s.trick.find(t=>t.seat===seat);$('played'+seat).innerHTML=t?cardHTML(t.card,true):'';}
 $('handPanel').classList.toggle('hidden',!['playing','roundEnd','finished'].includes(s.phase));$('handCount').textContent=`${s.hand.length} карт`;
 const playingTurn=s.phase==='playing'&&s.turn===s.me;$('hand').innerHTML=s.hand.map(c=>cardHTML(c,!playingTurn)).join('');$('hand').querySelectorAll('[data-card]').forEach(btn=>btn.onclick=()=>act('playCard',{cardId:btn.dataset.card}));
 $('roundEndPanel').classList.toggle('hidden',!['roundEnd','finished'].includes(s.phase));
 if(s.phase==='roundEnd'||s.phase==='finished'){
  $('roundTitle').textContent=s.phase==='finished'?'Матч завершён!':'Раздача завершена';const sum=s.roundSummary;
  if(sum){let detail=`Козырь ${sum.trump}. Очки раздачи после округления: команда A — ${sum.rounded[0]}, команда B — ${sum.rounded[1]}. Взятки: ${sum.tricksWon[0]} : ${sum.tricksWon[1]}. Счёт матча: ${s.teamScores[0]} : ${s.teamScores[1]}.`;if(sum.announcements.length)detail+=' Объявления: '+sum.announcements.join('; ');$('roundDetail').textContent=detail;}else $('roundDetail').textContent=`Счёт: ${s.teamScores[0]} : ${s.teamScores[1]}.`;
  $('nextRoundBtn').classList.toggle('hidden',!(s.phase==='roundEnd'&&s.host===socket.id));
  if(s.phase==='finished')$('roundDetail').textContent+=` ${s.teamScores[0]===s.teamScores[1]?'Ничья.':s.teamScores[0]>s.teamScores[1]?'Победила команда Север–Юг.':'Победила команда Восток–Запад.'}`;
 }
}
function escapeHTML(str){return String(str).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
