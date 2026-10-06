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
let serverClockOffsetMs = 0;
let timeoutResolveSentDeadline = null;
let reconnectTimer = null;
let reconnectWanted = false;
let actionSeq = 0;
let commonNameSavedForSession = null;
let lastTurnPopupKey = null;
let turnPopupTimer = null;
let lastHandledDrawLogKey = null;
let drawPopupTimer = null;
let localHandOrder = [];
let handOrderSessionId = null;
let handSortMode = 'free';
const HAND_ORDER_KEY_PREFIX = `${GAME_ID}-hand-order`;
const HAND_SORT_KEY_PREFIX = `${GAME_ID}-hand-sort`;

function handSortStorageKey(sessionId = state?.gameSessionId || 'lobby') {
  return `${HAND_SORT_KEY_PREFIX}:${sessionId || 'lobby'}:${myName || 'player'}`;
}

function loadStoredHandSortMode(sessionId) {
  try {
    const mode = localStorage.getItem(handSortStorageKey(sessionId));
    return ['number', 'color', 'free'].includes(mode) ? mode : 'free';
  } catch {
    return 'free';
  }
}

function saveStoredHandSortMode() {
  try { localStorage.setItem(handSortStorageKey(), handSortMode); } catch {}
}

function handOrderStorageKey(sessionId = state?.gameSessionId || 'lobby') {
  return `${HAND_ORDER_KEY_PREFIX}:${sessionId || 'lobby'}:${myId || myName || 'player'}`;
}

function loadStoredHandOrder(sessionId) {
  try {
    const value = JSON.parse(localStorage.getItem(handOrderStorageKey(sessionId)) || '[]');
    return Array.isArray(value) ? value.filter(id => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function saveStoredHandOrder() {
  try {
    localStorage.setItem(handOrderStorageKey(), JSON.stringify(localHandOrder));
  } catch {}
}

$('#nameInput').value = localStorage.getItem(COMMON_NAME_KEY) || '';

const RULES_HTML = `
  <h3>目的</h3><p>手札のタイルをすべて場へ出したプレイヤーが勝ちです。</p>
  <h3>使用タイル</h3><p>数字タイルは1～13を赤・青・黄・黒の4色、それぞれ2組ずつ使用します。数字タイル104枚にジョーカー2枚を加えた、合計106枚です。ゲーム開始時に各プレイヤーへ14枚ずつ配ります。</p>
  <h3>セット</h3><p><b>ラン</b>：同じ色の連続した数字を3枚以上。<br><b>グループ</b>：同じ数字を異なる色で3～4枚。</p>
  <h3>初回30点</h3><p>最初に場へ出すときは、自分の手札だけで合計30点以上必要です。達成するまでは場のタイルを組み替えられません。</p>
  <h3>手番</h3><p>タイルを場へ出して「確定」、または「1枚引く」で手番終了です。30点達成後は場のセットを自由に組み替えられますが、確定時に全セットが合法である必要があります。</p>
  <h3>ジョーカー</h3><p>任意のタイルとして使えます。場から回収した場合は、その手番中に再び場へ使用する必要があります。</p>
`;
const TERMS_HTML = `
  <dl class="terms-list">
    <dt>ラン</dt><dd>同じ色で数字が連続する3枚以上のセット。例：赤5・赤6・赤7。</dd>
    <dt>グループ</dt><dd>同じ数字で色がすべて異なる3～4枚のセット。例：赤8・青8・黒8。</dd>
    <dt>初回30点</dt><dd>初めてタイルを出すときに必要な合計点。自分の手札のみで作ります。</dd>
    <dt>ジョーカー</dt><dd>任意の色・数字を代用できる特殊タイル。</dd>
    <dt>山札</dt><dd>まだ誰にも配られていないタイル。出せないときはここから1枚引きます。</dd>
    <dt>確定</dt><dd>現在の組み替えをサーバーへ送信し、合法なら手番を終了します。</dd>
  </dl>
`;
function openInfo(title, html) {
  $('#infoTitle').textContent = title;
  $('#infoBody').innerHTML = html;
  $('#infoOverlay').classList.remove('hidden');
}
function closeInfo() { $('#infoOverlay').classList.add('hidden'); }
$('#rulesBtn').onclick = () => openInfo('ルール', RULES_HTML);
$('#termsBtn').onclick = () => openInfo('用語', TERMS_HTML);
$('#logBtn').onclick = () => { renderTurnLogs(); $('#logPanel').classList.remove('hidden'); };
$('#logCloseBtn').onclick = () => $('#logPanel').classList.add('hidden');
$('#infoCloseBtn').onclick = closeInfo;
$('#infoOverlay').onclick = event => { if (event.target === $('#infoOverlay')) closeInfo(); };
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeInfo(); });

function showScreen(name) {
  Object.values(screens).forEach(screen => screen.classList.remove('active'));
  screens[name].classList.add('active');
  $('#topLeaveBtn').classList.toggle('hidden', name === 'title');
  if (name !== 'game') $('#topTimer').textContent = '';
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
    card.innerHTML = `<h3>ROOM ${room.room}</h3><div class="room-state">${room.count} / 4人　${room.status || '待機中'}</div><div class="room-names">参加者：${(room.names || []).join(' / ') || 'なし'}</div><div class="row gap"><button class="join">参加する</button><button class="reset">初期化</button></div>`;
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
      if (Number.isFinite(Number(state?.serverNow))) {
        serverClockOffsetMs = Number(state.serverNow) - Date.now();
      }
      onRoomStateReceived(state);
      renderState();
      maybeShowDrawPopup();
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

  if (nextState.phase !== 'game') {
    lastTurnPopupKey = null;
    hideTurnPopup();
    return;
  }

  const currentPlayer = nextState.players?.[nextState.turnIndex];
  if (!currentPlayer) return;
  const turnKey = `${sessionId || 'game'}:${nextState.turnIndex}:${currentPlayer.id}`;
  if (turnKey !== lastTurnPopupKey) {
    lastTurnPopupKey = turnKey;
    showTurnPopup(currentPlayer.name, currentPlayer.id === myId);
  }
}

function showTurnPopup(playerName, isMe) {
  const popup = $('#turnPopup');
  const text = $('#turnPopupText');
  if (!popup || !text) return;
  clearTimeout(turnPopupTimer);
  text.textContent = isMe ? 'あなたの番です' : `${playerName}の番です`;
  popup.classList.remove('hidden', 'show');
  void popup.offsetWidth;
  popup.classList.add('show');
  turnPopupTimer = setTimeout(hideTurnPopup, 900);
}

function hideTurnPopup() {
  const popup = $('#turnPopup');
  if (!popup) return;
  popup.classList.remove('show');
  clearTimeout(turnPopupTimer);
  turnPopupTimer = setTimeout(() => popup.classList.add('hidden'), 180);
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
  $('#lobbyRoomTitle').textContent = `ROOM ${roomNo}`;
  const box = $('#lobbyPlayers');
  box.innerHTML = '';
  const me = state.players.find(player => player.id === myId);
  state.players.forEach(player => {
    const item = document.createElement('div');
    item.className = 'player-slot' + (player.host ? ' host' : '');
    item.innerHTML = `<b>${esc(player.name)}</b>${player.host ? '<span class="host-badge">HOST</span>' : ''}<div>${player.cpu ? `CPU Lv${player.cpuLevel}` : 'PLAYER'}</div>`;
    if (player.cpu && me?.host) {
      const remove = document.createElement('button');
      remove.className = 'cpu-remove-btn';
      remove.textContent = '削除';
      remove.dataset.cpuId = player.id;
      remove.onclick = () => send('removeCpu', { cpuId: player.id, actionId: newActionId('cpu-remove') });
      item.appendChild(remove);
    }
    box.appendChild(item);
  });
  $('#hostControls').classList.toggle('hidden', !me?.host);
  $('#turnSeconds').value = state.settings.turnSeconds;
  $('#cpuLevel').value = state.settings.cpuLevel || 2;
  lmsg(state.players.length < 2 ? '2人以上で開始できます。' : '');
}

function leaveRoomFromUi() {
  reconnectWanted = false;
  clearTimeout(reconnectTimer);
  send('leave');
  try { ws?.close(); } catch {}
  ws = null;
  state = null;
  lastHandledDrawLogKey = null;
  draft = null;
  myId = null;
  localStorage.removeItem(ACTIVE_ROOM_KEY);
  localStorage.removeItem(ACTIVE_NAME_KEY);
  roomId = null;
  roomNo = null;
  showScreen('title');
  refreshRooms();
}

$('#topLeaveBtn').onclick = leaveRoomFromUi;

$('#addCpuBtn').onclick = () => send('addCpu', { level: +$('#cpuLevel').value, actionId: newActionId('cpu') });
$('#turnSeconds').onchange = () => send('settings', { turnSeconds: +$('#turnSeconds').value, actionId: newActionId('settings') });
$('#startBtn').onclick = () => send('start', { actionId: newActionId('start') });

function cloneDraft(value) {
  return JSON.parse(JSON.stringify(value));
}

const SET_COLOR_ORDER = { red: 0, blue: 1, yellow: 2, black: 3 };

function sortSetTiles(set) {
  if (!Array.isArray(set) || set.length < 2) return set;
  const real = set.filter(tile => !tile.joker);
  const sameNumber = real.length > 0 && real.every(tile => tile.n === real[0].n);
  const sameColor = real.length > 0 && real.every(tile => tile.color === real[0].color);

  if (sameNumber) {
    set.sort((a, b) => {
      if (a.joker !== b.joker) return a.joker ? 1 : -1;
      return (SET_COLOR_ORDER[a.color] ?? 9) - (SET_COLOR_ORDER[b.color] ?? 9);
    });
    return set;
  }

  if (sameColor) {
    const jokers = set.filter(tile => tile.joker);
    const numbers = set.filter(tile => !tile.joker).sort((a, b) => a.n - b.n);
    const arranged = [];
    let jokerIndex = 0;
    for (let i = 0; i < numbers.length; i += 1) {
      if (i > 0) {
        let expected = numbers[i - 1].n + 1;
        while (expected < numbers[i].n && jokerIndex < jokers.length) {
          arranged.push(jokers[jokerIndex++]);
          expected += 1;
        }
      }
      arranged.push(numbers[i]);
    }
    while (jokerIndex < jokers.length) {
      const lastNumber = [...arranged].reverse().find(tile => !tile.joker)?.n ?? 0;
      if (lastNumber + (jokers.length - jokerIndex) <= 13) arranged.push(jokers[jokerIndex++]);
      else arranged.unshift(jokers[jokerIndex++]);
    }
    set.splice(0, set.length, ...arranged);
    return set;
  }

  set.sort((a, b) => {
    if (a.joker !== b.joker) return a.joker ? 1 : -1;
    return (a.n ?? 99) - (b.n ?? 99) || (SET_COLOR_ORDER[a.color] ?? 9) - (SET_COLOR_ORDER[b.color] ?? 9);
  });
  return set;
}

function normalizeField(field) {
  const nonEmpty = (field || []).filter(set => Array.isArray(set) && set.length > 0);
  nonEmpty.forEach(sortSetTiles);
  return [...nonEmpty, []];
}

function applyHandSortMode(tiles) {
  const list = [...(tiles || [])];
  const order = { red: 0, blue: 1, yellow: 2, black: 3 };
  if (handSortMode === 'number') {
    list.sort((a, b) => (a.joker ? 99 : a.n) - (b.joker ? 99 : b.n) || (order[a.color] ?? 9) - (order[b.color] ?? 9));
  } else if (handSortMode === 'color') {
    list.sort((a, b) => (order[a.color] ?? 9) - (order[b.color] ?? 9) || (a.joker ? 99 : a.n) - (b.joker ? 99 : b.n));
  }
  return list;
}

function reconcileLocalHandOrder(hand) {
  const tiles = hand || [];
  if (handSortMode === 'number' || handSortMode === 'color') {
    const sorted = applyHandSortMode(tiles);
    localHandOrder = sorted.map(tile => tile.id);
    saveStoredHandOrder();
    return sorted;
  }
  const byId = new Map(tiles.map(tile => [tile.id, tile]));
  const nextIds = localHandOrder.filter(id => byId.has(id));
  for (const tile of tiles) if (!nextIds.includes(tile.id)) nextIds.push(tile.id);
  localHandOrder = nextIds;
  saveStoredHandOrder();
  return nextIds.map(id => byId.get(id)).filter(Boolean);
}

function syncLocalHandOrderFromDraft() {
  if (draft?.hand) {
    localHandOrder = draft.hand.map(tile => tile.id);
    saveStoredHandOrder();
  }
}

function initDraft() {
  const me = state.players.find(player => player.id === myId);
  const sessionId = state.gameSessionId || null;
  if (handOrderSessionId !== sessionId) {
    handOrderSessionId = sessionId;
    localHandOrder = loadStoredHandOrder(sessionId);
    handSortMode = loadStoredHandSortMode(sessionId);
  }
  draft = {
    field: normalizeField(cloneDraft(state.field)),
    hold: [],
    hand: cloneDraft(reconcileLocalHandOrder(me?.hand || []))
  };
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
  syncLocalHandOrderFromDraft();
  send('draftDirty', {
    dirty: (draft.hold?.length || 0) > 0 || JSON.stringify(draft.field.filter(set => set.length)) !== JSON.stringify(state.field) || JSON.stringify(draft.hand.map(tile => tile.id).slice().sort()) !== JSON.stringify(originalHand.map(tile => tile.id).slice().sort())
  });
}

function renderGame() {
  confirmPending = false;
  showScreen('game');
  if (!draft || draft.baseVersion !== state.version) {
    initDraft();
    draft.baseVersion = state.version;
  }
  $('#playersBar').innerHTML = '';
  state.players.forEach((player, index) => {
    const item = document.createElement('div');
    item.className = 'player-chip' + (index === state.turnIndex ? ' turn' : '');
    item.dataset.playerId = player.id;
    item.dataset.playerName = player.name;
    item.innerHTML = `<div class="name">${esc(player.name)}${player.host ? ' ★' : ''}</div><div class="sub">${player.cpu ? 'CPU / ' : ''}${player.handCount}枚${player.initialDone ? ' / 30点達成' : ' / 初回30点未達'}</div>`;
    $('#playersBar').appendChild(item);
  });
  $('#poolText').textContent = `山札 ${state.poolCount}枚`;
  const mobilePool = $('#mobilePoolText');
  if (mobilePool) mobilePool.textContent = `山札 ${state.poolCount}枚`;
  renderTurnLogs();
  renderDraft();
  updateTurnUI();
  startTimer();
}

function latestDrawLogKey(log) {
  if (!log || !['draw', 'timeout'].includes(log.action)) return '';
  const count = Number(log.drawCount) || 0;
  if (count <= 0) return '';
  return [log.action, log.playerName || '', log.at || '', count].join('|');
}

function maybeShowDrawPopup() {
  if (!state || state.phase === 'lobby') return;
  const log = state.lastTurnLog;
  const key = latestDrawLogKey(log);
  if (lastHandledDrawLogKey === null) {
    // Joining/reconnecting mid-game should not replay an old popup.
    lastHandledDrawLogKey = key;
    return;
  }
  if (!key || key === lastHandledDrawLogKey) return;
  lastHandledDrawLogKey = key;

  const player = state.players.find(p => (log.playerId && p.id === log.playerId) || (!log.playerId && p.name === log.playerName));
  const chip = player
    ? document.querySelector(`.player-chip[data-player-id="${CSS.escape(player.id)}"]`)
    : [...document.querySelectorAll('.player-chip')].find(el => el.dataset.playerName === log.playerName);
  if (!chip) return;

  document.querySelectorAll('.draw-count-pop.global-pop').forEach(el => el.remove());
  const pop = document.createElement('div');
  const drawCount = Math.max(0, Number(log.drawCount) || 0);
  if (!drawCount) return;
  const penalty = log.action === 'timeout' && Number(log.requestedDrawCount || log.drawCount) >= 3;
  pop.className = 'draw-count-pop global-pop' + (penalty ? ' penalty' : '');
  if (penalty) {
    pop.innerHTML = `<span>ペナルティ</span><strong>+${drawCount}枚</strong>`;
  } else {
    pop.innerHTML = `<strong>+${drawCount}枚</strong>`;
  }

  // Keep the popup outside the player bar so it can never be clipped by
  // the board/top bar layout. Position it from the player's current chip.
  document.body.appendChild(pop);
  const rect = chip.getBoundingClientRect();
  const popWidth = pop.offsetWidth || 72;
  const left = Math.max(6, Math.min(window.innerWidth - popWidth - 6, rect.left + rect.width / 2 - popWidth / 2));
  const top = Math.max(52, Math.min(window.innerHeight - 72, rect.bottom + 6));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;

  requestAnimationFrame(() => pop.classList.add('show'));
  clearTimeout(drawPopupTimer);
  drawPopupTimer = setTimeout(() => {
    pop.classList.remove('show');
    setTimeout(() => pop.remove(), 220);
  }, 1800);
}

function tileLogLabel(tile) {
  if (!tile) return '';
  if (tile.joker) return 'JOKER';
  const names = { red: '赤', blue: '青', yellow: '黄', black: '黒' };
  return `${names[tile.color] || ''}${tile.n}`;
}

function turnLogText(log) {
  if (!log) return '';
  const poolText = Number.isFinite(Number(log.poolCount)) ? ` / 山札残り${Number(log.poolCount)}枚` : '';
  if (log.action === 'draw') return `${Number(log.drawCount) || 1}枚引いた${poolText}`;
  if (log.action === 'timeout') return `時間切れ（${Number(log.drawCount) || 0}枚引いた）${poolText}`;
  if (log.action === 'pass') return `${log.reason === 'timeout-pool-empty' ? '時間切れ・パス' : 'パス'}${poolText || ' / 山札残り0枚'}`;
  const labels = (log.tiles || []).map(tileLogLabel).filter(Boolean);
  return `${labels.length ? labels.join('・') : '場を組み替えた'}${poolText}`;
}

function renderTurnLogs() {
  const list = $('#logList');
  if (!list) return;
  const logs = Array.isArray(state?.turnLogs) && state.turnLogs.length
    ? state.turnLogs
    : (state?.lastTurnLog ? [state.lastTurnLog] : []);
  if (!logs.length) {
    list.innerHTML = '<div class="log-empty">まだログはありません</div>';
    return;
  }
  list.innerHTML = '';
  [...logs].reverse().forEach(log => {
    const row = document.createElement('div');
    row.className = 'log-entry';
    const when = log.at ? new Date(log.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    row.innerHTML = `<span class="log-player">${esc(log.playerName || '')}</span>${when ? `<span class="log-time">${esc(when)}</span>` : ''}<div>${esc(turnLogText(log))}</div>`;
    list.appendChild(row);
  });
}

function renderDraft() {
  if (!draft) return;
  draft.field = normalizeField(draft.field);
  const field = $('#setsArea');
  field.innerHTML = '';
  draft.field.forEach((set, setIndex) => {
    const setBox = document.createElement('div');
    setBox.className = 'set-box' + (set.length === 0 ? ' empty' : (validateSet(set) ? ' valid' : ' invalid'));
    setBox.dataset.si = setIndex;
    setBox.ondragover = event => { event.preventDefault(); setBox.classList.add('drag-over'); };
    setBox.ondragleave = () => setBox.classList.remove('drag-over');
    setBox.ondrop = event => { event.preventDefault(); setBox.classList.remove('drag-over'); moveSelectedToSet(setIndex); };
    set.forEach((tile, tileIndex) => setBox.appendChild(tileEl(tile, { zone: 'field', si: setIndex, ti: tileIndex })));
    setBox.onclick = event => { if (event.target === setBox && selected) moveSelectedToSet(setIndex); };
    field.appendChild(setBox);
  });
  const hold = $('#hold');
  hold.innerHTML = '';
  (draft.hold || []).forEach((tile, holdIndex) => hold.appendChild(tileEl(tile, { zone: 'hold', hi: holdIndex })));
  hold.classList.toggle('has-tiles', (draft.hold || []).length > 0);

  const hand = $('#hand');
  hand.innerHTML = '';
  draft.hand.forEach((tile, handIndex) => hand.appendChild(tileEl(tile, { zone: 'hand', hi: handIndex })));
  $('#handCount').textContent = `${draft.hand.length}枚`;
  renderInitialStatus();
  validatePreview();
}

let longPressTimer = null;
let longPressActive = false;
let longPressPointerId = null;
let longPressSourceEl = null;
let longPressDropTarget = null;
let suppressTileClickUntil = 0;
let longPressGhost = null;
let confirmPending = false;

function clearLongPressDragVisuals() {
  document.querySelectorAll('.longpress-over').forEach(el => el.classList.remove('longpress-over'));
  if (longPressSourceEl) longPressSourceEl.classList.remove('longpress-dragging');
  if (longPressGhost) longPressGhost.remove();
  longPressGhost = null;
  longPressDropTarget = null;
}

function createFloatingTileGhost(source, x, y) {
  if (longPressGhost) longPressGhost.remove();
  const ghost = source.cloneNode(true);
  ghost.classList.remove('selected', 'locked', 'longpress-dragging');
  ghost.classList.add('tile-drag-ghost');
  document.body.appendChild(ghost);
  longPressGhost = ghost;
  moveFloatingTileGhost(x, y);
}

function moveFloatingTileGhost(x, y) {
  if (!longPressGhost) return;
  longPressGhost.style.left = `${x}px`;
  longPressGhost.style.top = `${y}px`;
}

function longPressTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  return el.closest('.set-box, #holdZone, #hand');
}

function finishLongPressDrop(target) {
  if (!selected || !target) return;
  if (target.classList.contains('set-box')) {
    const setIndex = Number(target.dataset.si);
    if (Number.isInteger(setIndex)) moveSelectedToSet(setIndex);
    return;
  }
  if (target.id === 'holdZone') {
    moveSelectedToHoldArea();
    return;
  }
  if (target.id === 'hand') {
    if (selected.zone === 'field') moveSelectedToHand(selected);
  }
}

function bindLongPressMove(item, position, lockedInitialField) {
  item.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' || lockedInitialField || !isMyTurn()) return;
    clearTimeout(longPressTimer);
    longPressActive = false;
    longPressPointerId = event.pointerId;
    longPressSourceEl = item;
    longPressTimer = setTimeout(() => {
      longPressActive = true;
      selected = JSON.parse(JSON.stringify(position));
      suppressTileClickUntil = Date.now() + 650;
      item.classList.add('longpress-dragging');
      createFloatingTileGhost(item, event.clientX, event.clientY);
      try { item.setPointerCapture(event.pointerId); } catch {}
      if (navigator.vibrate) navigator.vibrate(18);
    }, 400);
  }, { passive: true });

  item.addEventListener('pointermove', event => {
    if (!longPressActive || event.pointerId !== longPressPointerId) return;
    event.preventDefault();
    moveFloatingTileGhost(event.clientX, event.clientY);
    const target = longPressTargetAt(event.clientX, event.clientY);
    if (target !== longPressDropTarget) {
      document.querySelectorAll('.longpress-over').forEach(el => el.classList.remove('longpress-over'));
      longPressDropTarget = target;
      if (longPressDropTarget) longPressDropTarget.classList.add('longpress-over');
    }
  }, { passive: false });

  const finish = event => {
    clearTimeout(longPressTimer);
    if (longPressActive && event.pointerId === longPressPointerId) {
      event.preventDefault();
      const target = longPressDropTarget || longPressTargetAt(event.clientX, event.clientY);
      finishLongPressDrop(target);
      suppressTileClickUntil = Date.now() + 650;
    }
    longPressActive = false;
    longPressPointerId = null;
    clearLongPressDragVisuals();
  };
  item.addEventListener('pointerup', finish, { passive: false });
  item.addEventListener('pointercancel', finish, { passive: false });
}

function tileEl(tile, position) {
  const item = document.createElement('div');
  item.className = `tile ${tile.joker ? 'joker' : tile.color}` + (selected && selected.zone === position.zone && selected.si === position.si && selected.ti === position.ti && selected.hi === position.hi ? ' selected' : '');
  item.draggable = true;
  if (tile.joker) item.innerHTML = '<span class="joker-mark">★</span><span class="joker-word">JOKER</span>';
  else item.textContent = tile.n;
  const lockedInitialField = position.zone === 'field' && !myInitialDone() && isOriginalFieldTile(tile.id);
  if (lockedInitialField) item.classList.add('locked');
  item.onclick = event => { event.stopPropagation(); if (Date.now() < suppressTileClickUntil) return; if (!lockedInitialField) selectTile(position); };
  item.ondragstart = event => {
    if (lockedInitialField) { event.preventDefault(); return; }
    selected = JSON.parse(JSON.stringify(position));
    item.classList.add('native-drag-source');
    const ghost = item.cloneNode(true);
    ghost.classList.remove('selected', 'locked', 'native-drag-source');
    ghost.classList.add('native-drag-image');
    document.body.appendChild(ghost);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', tile.id);
      event.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
    }
    setTimeout(() => ghost.remove(), 0);
  };
  item.ondragend = () => item.classList.remove('native-drag-source');
  bindLongPressMove(item, position, lockedInitialField);
  item.ondblclick = event => {
    event.stopPropagation();
    if (position.zone === 'field') {
      if (isOriginalFieldTile(tile.id)) moveSelectedToHold(position);
      else moveSelectedToHand(position);
    }
  };
  return item;
}

function myInitialDone() {
  return !!state?.players?.find(player => player.id === myId)?.initialDone;
}

function originalFieldIdSet() {
  return new Set((state?.field || []).flat().map(tile => tile.id));
}

function isOriginalFieldTile(tileId) {
  return originalFieldIdSet().has(tileId);
}

function peekSelected() {
  if (!selected || !draft) return null;
  if (selected.zone === 'hand') return draft.hand[selected.hi] || null;
  if (selected.zone === 'hold') return draft.hold?.[selected.hi] || null;
  return draft.field[selected.si]?.[selected.ti] || null;
}

function selectTile(position) {
  selected = JSON.parse(JSON.stringify(position));
  renderDraft();
}

function takeSelected() {
  if (!selected) return null;
  if (selected.zone === 'hand') return draft.hand.splice(selected.hi, 1)[0];
  if (selected.zone === 'hold') return draft.hold.splice(selected.hi, 1)[0];
  return draft.field[selected.si].splice(selected.ti, 1)[0];
}

function moveSelectedToSet(setIndex) {
  if (!isMyTurn()) return;
  const tile = peekSelected();
  if (!tile) return;
  const initialDone = myInitialDone();
  const target = draft.field[setIndex] || [];
  if (!initialDone) {
    if (isOriginalFieldTile(tile.id) || target.some(item => isOriginalFieldTile(item.id))) {
      msg('初回30点を達成するまでは、既に場にあるセットを組み替えられません。', true);
      return;
    }
  }
  const moved = takeSelected();
  if (!moved) return;
  draft.field[setIndex].push(moved);
  sortSetTiles(draft.field[setIndex]);
  draft.field = normalizeField(draft.field);
  selected = null;
  pushHistory();
  renderDraft();
}

function moveSelectedToHold(position = selected) {
  if (!isMyTurn() || !position || position.zone !== 'field') return;
  const tile = draft.field[position.si]?.[position.ti];
  if (!tile) return;
  if (!myInitialDone()) {
    msg('初回30点を達成するまでは、場のタイルを動かせません。', true);
    return;
  }
  if (!isOriginalFieldTile(tile.id)) {
    msg('保留置き場には、ターン開始時から場にあったタイルだけ置けます。', true);
    return;
  }
  draft.field[position.si].splice(position.ti, 1);
  draft.hold = draft.hold || [];
  draft.hold.push(tile);
  draft.field = normalizeField(draft.field);
  selected = null;
  pushHistory();
  renderDraft();
}

function moveSelectedToHand(position = selected) {
  if (!isMyTurn() || !position || position.zone !== 'field') return;
  const tile = draft.field[position.si]?.[position.ti];
  if (!tile) return;
  if (isOriginalFieldTile(tile.id)) {
    msg('場にあったタイルを手札へ戻すことはできません。保留置き場を使ってください。', true);
    return;
  }
  draft.field[position.si].splice(position.ti, 1);
  draft.hand.push(tile);
  syncLocalHandOrderFromDraft();
  draft.field = normalizeField(draft.field);
  selected = null;
  pushHistory();
  renderDraft();
}

function moveSelectedToHoldArea() {
  if (!selected || selected.zone !== 'field') {
    if (selected?.zone === 'hand') msg('自分の手札は保留置き場へ置けません。', true);
    return;
  }
  moveSelectedToHold(selected);
}

const holdZone = $('#holdZone');
holdZone.ondragover = event => { event.preventDefault(); holdZone.classList.add('drag-over'); };
holdZone.ondragleave = () => holdZone.classList.remove('drag-over');
holdZone.ondrop = event => { event.preventDefault(); holdZone.classList.remove('drag-over'); moveSelectedToHoldArea(); };
holdZone.onclick = event => { if (event.target === holdZone || event.target.id === 'hold') moveSelectedToHoldArea(); };

$('#undoBtn').onclick = () => { if (historyIndex > 0) { historyIndex -= 1; draft = cloneDraft(history[historyIndex]); draft.baseVersion = state.version; selected = null; syncLocalHandOrderFromDraft(); renderDraft(); } };
$('#redoBtn').onclick = () => { if (historyIndex < history.length - 1) { historyIndex += 1; draft = cloneDraft(history[historyIndex]); draft.baseVersion = state.version; selected = null; syncLocalHandOrderFromDraft(); renderDraft(); } };
$('#resetDraftBtn').onclick = () => { initDraft(); draft.baseVersion = state.version; renderDraft(); };
function buildConfirmPayload() {
  let fieldPayload = draft.field
    .filter(set => set.length)
    .map(set => set.map(tile => tile.id));

  // 初回30点前は、既存盤面をクライアント編集結果から再構築しない。
  if (!myInitialDone()) {
    const currentHandIds = new Set(draft.hand.map(tile => tile.id));
    const originalHand = state.players.find(player => player.id === myId)?.hand || [];
    const playedIds = new Set(originalHand.map(tile => tile.id).filter(id => !currentHandIds.has(id)));
    const newSets = draft.field
      .filter(set => set.length > 0 && set.every(tile => playedIds.has(tile.id)))
      .map(set => set.map(tile => tile.id));
    const originalField = (state.field || []).map(set => set.map(tile => tile.id));
    fieldPayload = [...originalField, ...newSets];
  }

  return {
    field: fieldPayload,
    hand: draft.hand.map(tile => tile.id)
  };
}

async function confirmCurrentDraft() {
  if (!isMyTurn() || confirmPending) return;
  if ((draft.hold?.length || 0) > 0) { msg('保留置き場のタイルをすべて場へ戻してから確定してください。', true); return; }

  const payload = buildConfirmPayload();
  confirmPending = true;
  $('#confirmBtn').disabled = true;
  msg('確定中…');
  send('confirm', { ...payload, actionId: newActionId('confirm') });
  // WebSocket state/error responseで通常すぐ解除される。通信断などでも操作不能にしない。
  setTimeout(() => {
    if (confirmPending) {
      confirmPending = false;
      updateTurnUI();
    }
  }, 1800);
}
$('#confirmBtn').addEventListener('click', event => { event.preventDefault(); confirmCurrentDraft(); });
$('#drawBtn').onclick = () => { if (isMyTurn()) send('draw'); };
$$('[data-sort]').forEach(button => button.onclick = () => sortHand(button.dataset.sort));

function sortHand(mode) {
  if (!draft) return;
  handSortMode = ['number', 'color', 'free'].includes(mode) ? mode : 'free';
  saveStoredHandSortMode();
  if (handSortMode !== 'free') draft.hand = applyHandSortMode(draft.hand);
  syncLocalHandOrderFromDraft();
  renderDraft();
}

function isMyTurn() {
  return state?.phase === 'game' && state.players[state.turnIndex]?.id === myId;
}

function updateTurnUI() {
  const mine = isMyTurn();
  ['undoBtn', 'redoBtn', 'resetDraftBtn', 'drawBtn'].forEach(id => { $('#' + id).disabled = !mine; });
  const drawBtn = $('#drawBtn');
  if (drawBtn) drawBtn.textContent = Number(state?.poolCount) > 0 ? '1枚引く' : 'パス';
  $('#confirmBtn').disabled = !mine || confirmPending;
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

function scoreSet(set) {
  if (!validateSet(set)) return 0;
  const real = set.filter(tile => !tile.joker);
  const sameNumber = real.every(tile => tile.n === real[0].n)
    && new Set(real.map(tile => tile.color)).size === real.length
    && set.length <= 4;
  if (sameNumber) return real[0].n * set.length;
  let base = null;
  for (let index = 0; index < set.length; index += 1) {
    if (!set[index].joker) {
      const candidate = set[index].n - index;
      if (base === null) base = candidate;
    }
  }
  if (base === null) return 0;
  return set.reduce((total, tile, index) => total + (tile.joker ? base + index : tile.n), 0);
}

function currentInitialScore() {
  if (!draft || myInitialDone()) return 30;
  const original = originalFieldIdSet();
  return draft.field
    .filter(set => set.length && set.every(tile => !original.has(tile.id)) && validateSet(set))
    .reduce((total, set) => total + scoreSet(set), 0);
}

function renderInitialStatus() {
  const el = $('#initialStatus');
  const mobile = $('#mobileInitialStatus');
  if (!el) return;
  if (myInitialDone()) {
    el.textContent = '初回30点：達成済み';
    el.className = 'initial-status done';
    if (mobile) { mobile.textContent = ''; mobile.classList.add('hidden'); }
    return;
  }
  const score = currentInitialScore();
  el.textContent = `初回30点：${score} / 30点${score >= 30 ? '（達成可能）' : ''}`;
  el.className = 'initial-status ' + (score >= 30 ? 'ready' : 'waiting');
  if (mobile) { mobile.textContent = `${score}/30`; mobile.classList.remove('hidden'); }
}

function validatePreview() {
  if (!draft) return;
  [...$('#setsArea').children].forEach((element, index) => {
    const set = draft.field[index];
    element.classList.toggle('empty', set.length === 0);
    element.classList.toggle('valid', set.length > 0 && validateSet(set));
    element.classList.toggle('invalid', set.length > 0 && !validateSet(set));
  });
}

function startTimer() {
  clearInterval(timerHandle);
  const tick = () => {
    const el = $('#topTimer');
    if (!el) return;
    if (!state?.deadline) {
      el.textContent = '';
      timeoutResolveSentDeadline = null;
      return;
    }
    const deadline = Number(state.deadline);
    const serverNow = Date.now() + serverClockOffsetMs;
    const remainingMs = deadline - serverNow;
    const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
    el.textContent = `残り ${seconds}秒`;

    // 0秒到達時は現在の盤面をサーバーへ送り、
    // 確定可能なら自動確定、不可ならサーバー側でペナルティ処理する。
    if (remainingMs <= 0 && isMyTurn() && draft && timeoutResolveSentDeadline !== deadline) {
      timeoutResolveSentDeadline = deadline;
      const payload = buildConfirmPayload();
      send('timeoutConfirm', {
        ...payload,
        holdCount: (draft.hold || []).length,
        actionId: newActionId('timeout-confirm')
      });
    }
  };
  tick();
  timerHandle = setInterval(tick, 200);
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
