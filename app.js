const SERVER_URL = localStorage.getItem('rummikub_server_url') || 'https://rummikub-online.naitoryo7110.workers.dev';
const GAME_ID = 'rummikub';
const COMMON_NAME_KEY = 'boardgamePlayerName';
const ACTIVE_ROOM_KEY = `${GAME_ID}-online-room`;
const ACTIVE_NAME_KEY = `${GAME_ID}-online-active-name`;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const screens = { title: $('#titleScreen'), lobby: $('#lobbyScreen'), game: $('#gameScreen') };
let ws = null;
let roomNo = null;
let roomId = null;
let myName = '';
let myId = null;
let state = null;
let draft = null;
let history = [];
let historyIndex = -1;
let selected = null;
let timerHandle = null;
let reconnectTimer = null;
let reconnectWanted = false;
let actionSeq = 0;
let commonNameSavedForSession = null;

$('#nameInput').value = localStorage.getItem(COMMON_NAME_KEY) || '';

function showScreen(name) {
  Object.values(screens).forEach(screen => screen.classList.remove('active'));
  screens[name].classList.add('active');
}

function msg(text, error = false) {
  $('#gameMessage').textContent = text || '';
  $('#gameMessage').className = 'message' + (error ? ' error' : '');
}

function lmsg(text) {
  $('#lobbyMessage').textContent = text || '';
}

function newActionId(prefix = 'op') {
  actionSeq = (actionSeq + 1) % 1000000;
  return [prefix, Date.now(), actionSeq, Math.random().toString(36).slice(2, 8)].join('-');
}

function tokenKey(id) {
  return `${GAME_ID}-online-token-${id}`;
}

function getOrCreateToken(id) {
  let token = localStorage.getItem(tokenKey(id));
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem(tokenKey(id), token);
  }
  return token;
}

async function api(path, options) {
  const response = await fetch(SERVER_URL + path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function refreshRooms() {
  try {
    const data = await api('/api/rooms', { cache: 'no-store' });
    renderRooms(data.rooms || []);
  } catch {
    renderRooms([1, 2, 3, 4].map(number => ({ room: number, count: 0, names: [], status: '取得失敗' })));
  }
}

function renderRooms(rooms) {
  const grid = $('#roomGrid');
  grid.innerHTML = '';
  rooms.forEach(room => {
    const card = document.createElement('div');
    card.className = 'room-card';
    card.innerHTML = `<h3>ROOM${room.room}</h3><div class="room-state">${room.count}/4 ・ ${room.status || '待機中'}</div><div class="room-names">${(room.names || []).join(' / ') || '参加者なし'}</div><div class="row gap"><button class="join">参加</button><button class="reset">初期化</button></div>`;
    card.querySelector('.join').onclick = () => joinRoom(room.room);
    card.querySelector('.reset').onclick = () => resetRoom(room.room);
    grid.appendChild(card);
  });
}

async function resetRoom(number) {
  if (!confirm(`ROOM ${number} を初期化しますか？`)) return;
  try {
    await api(`/reset-empty?roomId=room${number}`, { method: 'POST', cache: 'no-store' });
    if (localStorage.getItem(ACTIVE_ROOM_KEY) === `room${number}`) {
      localStorage.removeItem(ACTIVE_ROOM_KEY);
      localStorage.removeItem(ACTIVE_NAME_KEY);
    }
    await refreshRooms();
  } catch (error) {
    alert(error.message);
  }
}

async function checkRoomJoin(targetRoomId, playerName, token) {
  const url = new URL(SERVER_URL + '/join-check');
  url.searchParams.set('roomId', targetRoomId);
  url.searchParams.set('name', playerName);
  url.searchParams.set('token', token);
  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'ROOMへ参加できません。');
  return data;
}

async function joinRoom(number, reconnect = false) {
  const name = reconnect ? myName : $('#nameInput').value.trim();
  if (!name) {
    if (!reconnect) alert('名前を入力してください。');
    return;
  }

  const nextRoomId = `room${number}`;
  const token = getOrCreateToken(nextRoomId);
  try {
    await checkRoomJoin(nextRoomId, name, token);
  } catch (error) {
    if (!reconnect) alert(error.message);
    else lmsg(error.message);
    return;
  }

  myName = name;
  roomNo = number;
  roomId = nextRoomId;
  reconnectWanted = true;
  localStorage.setItem(ACTIVE_ROOM_KEY, roomId);
  localStorage.setItem(ACTIVE_NAME_KEY, myName);
  openWS(token);
}

function openWS(token = getOrCreateToken(roomId)) {
  clearTimeout(reconnectTimer);
  if (ws) {
    try { ws.close(); } catch {}
  }

  const url = SERVER_URL.replace(/^http/, 'ws') + `/api/room/${roomNo}/ws?name=${encodeURIComponent(myName)}&token=${encodeURIComponent(token)}&roomId=${encodeURIComponent(roomId)}`;
  ws = new WebSocket(url);

  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'error') {
      alert(message.error);
      return;
    }
    if (message.type === 'welcome') myId = message.playerId;
    if (message.type === 'state') {
      state = message.state;
      onRoomStateReceived(state);
      renderState();
    }
  };

  ws.onclose = () => {
    ws = null;
    if (reconnectWanted && roomId) {
      lmsg('再接続しています…');
      scheduleReconnect();
    }
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    if (!reconnectWanted || !roomId || ws?.readyState === WebSocket.OPEN) return;
    const number = Number(roomId.replace('room', ''));
    await joinRoom(number, true);
  }, 1200);
}

function onRoomStateReceived(nextState) {
  const started = nextState.phase === 'game' || nextState.phase === 'result';
  const sessionId = nextState.gameSessionId || null;
  if (started && sessionId && commonNameSavedForSession !== sessionId) {
    localStorage.setItem(COMMON_NAME_KEY, myName);
    commonNameSavedForSession = sessionId;
  }
}

function send(type, data = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data }));
}

function renderState() {
  if (!state) return;
  if (state.phase === 'lobby') renderLobby();
  else {
    renderGame();
    if (state.phase === 'result') renderResult();
  }
}

function renderLobby() {
  showScreen('lobby');
  $('#lobbyRoomTitle').textContent = `ROOM${roomNo}`;
  const box = $('#lobbyPlayers');
  box.innerHTML = '';
  state.players.forEach(player => {
    const item = document.createElement('div');
    item.className = 'player-slot' + (player.host ? ' host' : '');
    item.innerHTML = `<b>${esc(player.name)}</b>${player.host ? '<span class="host-badge">HOST</span>' : ''}<div>${player.cpu ? `CPU Lv${player.cpuLevel}` : 'PLAYER'}</div>`;
    box.appendChild(item);
  });
  const me = state.players.find(player => player.id === myId);
  $('#hostControls').classList.toggle('hidden', !me?.host);
  $('#turnSeconds').value = state.settings.turnSeconds;
  $('#cpuLevel').value = state.settings.cpuLevel || 2;
  lmsg(state.players.length < 2 ? '2人以上で開始できます。' : '');
}

$('#leaveBtn').onclick = () => {
  reconnectWanted = false;
  clearTimeout(reconnectTimer);
  send('leave');
  try { ws?.close(); } catch {}
  ws = null;
  state = null;
  myId = null;
  localStorage.removeItem(ACTIVE_ROOM_KEY);
  localStorage.removeItem(ACTIVE_NAME_KEY);
  roomId = null;
  roomNo = null;
  showScreen('title');
  refreshRooms();
};

$('#addCpuBtn').onclick = () => send('addCpu', { level: +$('#cpuLevel').value, actionId: newActionId('cpu') });
$('#turnSeconds').onchange = () => send('settings', { turnSeconds: +$('#turnSeconds').value, actionId: newActionId('settings') });
$('#startBtn').onclick = () => send('start', { actionId: newActionId('start') });

function cloneDraft(value) {
  return JSON.parse(JSON.stringify(value));
}

function initDraft() {
  const me = state.players.find(player => player.id === myId);
  draft = { field: cloneDraft(state.field), hand: cloneDraft(me?.hand || []) };
  history = [cloneDraft(draft)];
  historyIndex = 0;
  selected = null;
  send('draftDirty', { dirty: false });
}

function pushHistory() {
  history = history.slice(0, historyIndex + 1);
  history.push(cloneDraft(draft));
  historyIndex = history.length - 1;
  const originalHand = state.players.find(player => player.id === myId)?.hand || [];
  send('draftDirty', {
    dirty: JSON.stringify(draft.field) !== JSON.stringify(state.field) || JSON.stringify(draft.hand) !== JSON.stringify(originalHand)
  });
}

function renderGame() {
  showScreen('game');
  if (!draft || draft.baseVersion !== state.version) {
    initDraft();
    draft.baseVersion = state.version;
  }
  $('#playersBar').innerHTML = '';
  state.players.forEach((player, index) => {
    const item = document.createElement('div');
    item.className = 'player-chip' + (index === state.turnIndex ? ' turn' : '');
    item.innerHTML = `<div class="name">${esc(player.name)}${player.host ? ' ★' : ''}</div><div class="sub">${player.cpu ? 'CPU / ' : ''}${player.handCount}枚${player.initialDone ? ' / 30済' : ''}</div>`;
    $('#playersBar').appendChild(item);
  });
  $('#turnText').textContent = `手番: ${state.players[state.turnIndex]?.name || '-'}`;
  $('#poolText').textContent = `山札 ${state.poolCount}枚`;
  renderDraft();
  updateTurnUI();
  startTimer();
}

function renderDraft() {
  if (!draft) return;
  const field = $('#field');
  field.innerHTML = '';
  draft.field.forEach((set, setIndex) => {
    const setBox = document.createElement('div');
    setBox.className = 'set-box';
    setBox.dataset.si = setIndex;
    setBox.ondragover = event => { event.preventDefault(); setBox.classList.add('drag-over'); };
    setBox.ondragleave = () => setBox.classList.remove('drag-over');
    setBox.ondrop = event => { event.preventDefault(); setBox.classList.remove('drag-over'); moveSelectedToSet(setIndex); };
    set.forEach((tile, tileIndex) => setBox.appendChild(tileEl(tile, { zone: 'field', si: setIndex, ti: tileIndex })));
    setBox.onclick = event => { if (event.target === setBox && selected) moveSelectedToSet(setIndex); };
    field.appendChild(setBox);
  });
  const hand = $('#hand');
  hand.innerHTML = '';
  draft.hand.forEach((tile, handIndex) => hand.appendChild(tileEl(tile, { zone: 'hand', hi: handIndex })));
  $('#handCount').textContent = `${draft.hand.length}枚`;
  validatePreview();
}

function tileEl(tile, position) {
  const item = document.createElement('div');
  item.className = `tile ${tile.joker ? 'joker' : tile.color}` + (selected && selected.zone === position.zone && selected.si === position.si && selected.ti === position.ti && selected.hi === position.hi ? ' selected' : '');
  item.draggable = true;
  item.textContent = tile.joker ? 'JOKER' : tile.n;
  item.onclick = event => { event.stopPropagation(); selectTile(position); };
  item.ondragstart = () => { selected = position; };
  item.ondblclick = event => { event.stopPropagation(); if (position.zone === 'field') moveSelectedToHand(position); };
  return item;
}

function selectTile(position) {
  selected = JSON.parse(JSON.stringify(position));
  renderDraft();
}

function takeSelected() {
  if (!selected) return null;
  if (selected.zone === 'hand') return draft.hand.splice(selected.hi, 1)[0];
  return draft.field[selected.si].splice(selected.ti, 1)[0];
}

function moveSelectedToSet(setIndex) {
  if (!isMyTurn()) return;
  const tile = takeSelected();
  if (!tile) return;
  draft.field[setIndex].push(tile);
  selected = null;
  pushHistory();
  renderDraft();
}

function moveSelectedToHand(position = selected) {
  if (!isMyTurn() || !position || position.zone !== 'field') return;
  const tile = draft.field[position.si].splice(position.ti, 1)[0];
  draft.hand.push(tile);
  selected = null;
  pushHistory();
  renderDraft();
}

$('#newSetBtn').onclick = () => {
  if (!isMyTurn()) return;
  if (selected) {
    const tile = takeSelected();
    draft.field.push([tile]);
    selected = null;
  } else draft.field.push([]);
  pushHistory();
  renderDraft();
};
$('#deleteEmptyBtn').onclick = () => { draft.field = draft.field.filter(set => set.length); pushHistory(); renderDraft(); };
$('#undoBtn').onclick = () => { if (historyIndex > 0) { historyIndex -= 1; draft = cloneDraft(history[historyIndex]); draft.baseVersion = state.version; selected = null; renderDraft(); } };
$('#redoBtn').onclick = () => { if (historyIndex < history.length - 1) { historyIndex += 1; draft = cloneDraft(history[historyIndex]); draft.baseVersion = state.version; selected = null; renderDraft(); } };
$('#resetDraftBtn').onclick = () => { initDraft(); draft.baseVersion = state.version; renderDraft(); };
$('#confirmBtn').onclick = () => { if (isMyTurn()) send('confirm', { field: draft.field.map(set => set.map(tile => tile.id)), hand: draft.hand.map(tile => tile.id) }); };
$('#drawBtn').onclick = () => { if (isMyTurn()) send('draw'); };
$$('[data-sort]').forEach(button => button.onclick = () => sortHand(button.dataset.sort));

function sortHand(mode) {
  if (!draft) return;
  const order = { red: 0, blue: 1, yellow: 2, black: 3 };
  if (mode === 'number') draft.hand.sort((a, b) => (a.joker ? 99 : a.n) - (b.joker ? 99 : b.n) || (order[a.color] ?? 9) - (order[b.color] ?? 9));
  if (mode === 'color') draft.hand.sort((a, b) => (order[a.color] ?? 9) - (order[b.color] ?? 9) || (a.n || 99) - (b.n || 99));
  renderDraft();
}

function isMyTurn() {
  return state?.phase === 'game' && state.players[state.turnIndex]?.id === myId;
}

function updateTurnUI() {
  const mine = isMyTurn();
  ['newSetBtn', 'deleteEmptyBtn', 'undoBtn', 'redoBtn', 'resetDraftBtn', 'confirmBtn', 'drawBtn'].forEach(id => { $('#' + id).disabled = !mine; });
}

function validateSet(set) {
  if (set.length < 3) return false;
  const real = set.filter(tile => !tile.joker);
  if (!real.length) return false;
  const sameNumber = real.every(tile => tile.n === real[0].n);
  const distinctColors = new Set(real.map(tile => tile.color)).size === real.length;
  if (sameNumber && distinctColors && set.length <= 4) return true;
  const sameColor = real.every(tile => tile.color === real[0].color);
  if (!sameColor) return false;
  let base = null;
  for (let index = 0; index < set.length; index += 1) {
    const tile = set[index];
    if (tile.joker) continue;
    const candidate = tile.n - index;
    if (base === null) base = candidate;
    else if (base !== candidate) return false;
  }
  return base !== null && base >= 1 && base + set.length - 1 <= 13;
}

function validatePreview() {
  if (!draft) return;
  [...$('#field').children].forEach((element, index) => element.classList.toggle('invalid', draft.field[index].length > 0 && !validateSet(draft.field[index])));
}

function startTimer() {
  clearInterval(timerHandle);
  const tick = () => {
    if (!state?.deadline) { $('#timerText').textContent = '制限なし'; return; }
    const seconds = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
    $('#timerText').textContent = `残り ${seconds}秒`;
  };
  tick();
  timerHandle = setInterval(tick, 500);
}

function renderResult() {
  const overlay = $('#resultOverlay');
  overlay.classList.remove('hidden');
  $('#resultBody').innerHTML = (state.result?.scores || []).map(score => `<div class="score-row"><b>${esc(score.name)}</b><span>${score.score > 0 ? '+' : ''}${score.score}</span></div>`).join('');
}

$('#backLobbyBtn').onclick = () => { send('backLobby'); $('#resultOverlay').classList.add('hidden'); };

function esc(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && roomId && (!ws || ws.readyState !== WebSocket.OPEN)) scheduleReconnect();
});
window.addEventListener('online', () => {
  if (roomId && (!ws || ws.readyState !== WebSocket.OPEN)) scheduleReconnect();
});
window.addEventListener('beforeunload', () => { try { ws?.close(); } catch {} });

async function boot() {
  await refreshRooms();
  const savedRoom = localStorage.getItem(ACTIVE_ROOM_KEY);
  const savedName = localStorage.getItem(ACTIVE_NAME_KEY);
  if (savedRoom && savedName && /^room[1-4]$/.test(savedRoom)) {
    myName = savedName;
    $('#nameInput').value = savedName;
    await joinRoom(Number(savedRoom.replace('room', '')), true);
  }
}

boot();
