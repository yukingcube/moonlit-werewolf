/* ============================================================
   js/main.js
   UI制御 / イベントハンドラ / 画面遷移 / DOMレンダリング
   ============================================================ */
'use strict';

(function() {
  const GD = window.GameData;
  const AI = window.AI;
  const FB = window.FirebaseAPI;
  const Game = window.Game;
  const { CONFIG, ROLES, TEAMS, REACTION_STYLES, PHASES } = GD;

  /* ============================================================
     ローカルUI状態
     ============================================================ */
  const ui = {
    currentScreen: 'title',
    selectedNightTarget: null,
    selectedVoteTarget: null,
    sentMessages: [],          // [{ targetName, text }]
    morningSpeechesShown: 0,
    cleanupLobby: null,
    discussionScrollPinned: true
  };

  /* ============================================================
     DOM ヘルパ
     ============================================================ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const screens = () => $$('.screen');

  function showScreen(name) {
    for (const s of screens()) {
      const match = s.dataset.screen === name;
      s.hidden = !match;
    }
    ui.currentScreen = name;
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function showLoading(msg, sub) {
    const ov = $('#loadingOverlay');
    if (msg == null) { ov.hidden = true; return; }
    $('#loadingMessage').textContent = msg;
    $('#loadingSubMessage').textContent = sub || '';
    ov.hidden = false;
  }

  function showError(message, title) {
    $('#errorTitle').textContent = title || 'エラー';
    $('#errorMessage').textContent = message || '不明なエラーが発生しました';
    $('#errorDialog').hidden = false;
  }
  function closeError() { $('#errorDialog').hidden = true; }

  function toast(msg, ms = 2200) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { t.hidden = true; }, ms);
  }

  /* ============================================================
     人間が読みやすいエラーメッセージへの変換
     ============================================================ */
  function humanizeError(err) {
    if (!err) return '不明なエラー';
    const msg = err.message || String(err);
    const map = {
      'ERR_NO_API_KEY': 'Gemini APIキーが設定されていません。設定画面で入力してください。',
      'ERR_KEY_INVALID': 'APIキーが無効です。設定を確認してください。',
      'ERR_429': 'API利用上限に達しました。しばらくしてから再試行してください。',
      'ERR_503': 'AIサーバーが混雑しています。再試行してください。',
      'ERR_EMPTY': 'AIが応答を返しませんでした。',
      'ERR_PARSE': 'AIの応答を解釈できませんでした。',
      'ERR_AUTH_FAILED': 'Firebase認証に失敗しました。',
      'ERR_AUTH_TIMEOUT': 'Firebase認証がタイムアウトしました。',
      'ERR_FIREBASE_NOT_READY': 'Firebaseの初期化が完了していません。',
      'ROOM_NOT_FOUND': '指定したルームが見つかりません。',
      'ROOM_IN_PROGRESS': 'そのルームは既にゲーム中です。',
      'ROOM_FULL': 'ルームは満員です。',
      'ALREADY_JOINED': '既にこのルームに参加しています。',
      'EMPTY_MESSAGE': '伝言を入力してください。',
      'CANT_SEND': '送信できません(死亡しているか未参加)。',
      'INVALID_TARGET': '送信先が不正です。'
    };
    for (const k of Object.keys(map)) {
      if (msg.startsWith(k)) return map[k];
    }
    return msg;
  }

  /* ============================================================
     設定: 名前 / APIキー
     ============================================================ */
  function loadStoredSettings() {
    const key = AI.getApiKey();
    const name = localStorage.getItem(CONFIG.PLAYER_NAME_STORAGE) || '';
    $('#apiKeyInput').value = key;
    $('#playerNameInput').value = name;
  }
  function saveSettings() {
    const key = $('#apiKeyInput').value.trim();
    const name = $('#playerNameInput').value.trim();
    AI.setApiKey(key);
    if (name) {
      localStorage.setItem(CONFIG.PLAYER_NAME_STORAGE, name.slice(0, CONFIG.NAME_MAX_LENGTH));
    } else {
      localStorage.removeItem(CONFIG.PLAYER_NAME_STORAGE);
    }
    toast('設定を保存しました');
    showScreen('title');
  }

  function getPlayerName() {
    let name = localStorage.getItem(CONFIG.PLAYER_NAME_STORAGE) || '';
    name = name.trim().slice(0, CONFIG.NAME_MAX_LENGTH);
    if (!name) name = '村人';
    return name;
  }

  /* ============================================================
     ルーム / ロビー
     ============================================================ */
  let lobbyMembers = [];

  function setupLobbyListeners() {
    if (ui.cleanupLobby) { try { ui.cleanupLobby(); } catch(_) {} ui.cleanupLobby = null; }
    const unsub1 = FB.listenPlayers((list) => {
      lobbyMembers = list;
      renderLobby(list);
    });
    const unsub2 = FB.listenMeta((meta) => {
      if (!meta) return;
      if (meta.status === 'playing') {
        // ゲスト: ホストがゲーム開始した
        if (!FB.isHost) {
          handleGuestGameStart();
        }
      }
    });
    ui.cleanupLobby = () => { try { unsub1(); } catch(_) {} try { unsub2(); } catch(_) {} };
  }

  function renderLobby(list) {
    $('#lobbyRoomId').textContent = FB.roomId || '------';
    const wrap = $('#lobbyPlayerList');
    wrap.innerHTML = '';
    for (const p of list) {
      const div = document.createElement('div');
      div.className = 'player-item' + (p.uid === FB.uid ? ' self' : '');
      const tag = p.isHost ? '<span class="player-tag">ホスト</span>' : '';
      div.innerHTML = `<span class="player-name">${GD.escapeHtml(p.name)}${p.uid === FB.uid ? '(あなた)' : ''}</span>${tag}`;
      wrap.appendChild(div);
    }
    const count = list.length;
    const status = $('#lobbyStatus');
    if (count >= CONFIG.TOTAL_PLAYERS) {
      status.textContent = `定員(${count}/${CONFIG.TOTAL_PLAYERS})に達しました`;
    } else {
      status.textContent = `仲間を待っています... (${count}/${CONFIG.TOTAL_PLAYERS})`;
    }
    const startBtn = $('#startGameBtn');
    if (FB.isHost && count >= 1) {
      startBtn.hidden = false;
      startBtn.textContent = `ゲーム開始 (${count}人 + AI ${Math.max(0, CONFIG.TOTAL_PLAYERS - count)}人)`;
    } else {
      startBtn.hidden = true;
    }
  }

  async function createRoom() {
    const name = getPlayerName();
    if (!AI.hasApiKey()) {
      showError('ホストには Gemini APIキーが必要です。設定画面で入力してください。', '設定エラー');
      return;
    }
    showLoading('ルームを作成中...', 'Firebaseに接続しています');
    try {
      await FB.initAuth();
      const roomId = await FB.createRoom(name);
      showLoading(null);
      showScreen('lobby');
      setupLobbyListeners();
    } catch (err) {
      showLoading(null);
      showError(humanizeError(err));
    }
  }

  async function joinRoom() {
    const name = getPlayerName();
    const id = $('#roomIdInput').value.trim();
    if (!/^\d{6}$/.test(id)) {
      showError('ルームIDは6桁の数字です');
      return;
    }
    showLoading('ルームに参加中...');
    try {
      await FB.initAuth();
      await FB.joinRoom(id, name);
      showLoading(null);
      showScreen('lobby');
      setupLobbyListeners();
    } catch (err) {
      showLoading(null);
      showError(humanizeError(err));
    }
  }

  async function leaveRoom() {
    if (ui.cleanupLobby) { try { ui.cleanupLobby(); } catch(_) {} ui.cleanupLobby = null; }
    try { await FB.leaveRoom(); } catch(_) {}
    showScreen('mode');
  }

  function copyRoomId() {
    const id = FB.roomId;
    if (!id) return;
    try {
      navigator.clipboard.writeText(id);
      toast('ルームIDをコピーしました');
    } catch (e) {
      toast('コピーに失敗しました');
    }
  }

  /* ============================================================
     ゲーム開始 (ホスト)
     ============================================================ */
  async function startGameAsHost() {
    if (ui.cleanupLobby) { try { ui.cleanupLobby(); } catch(_) {} ui.cleanupLobby = null; }
    showLoading('ゲームを準備中...', 'AIキャラクターを召喚しています');
    try {
      const list = lobbyMembers.length ? lobbyMembers : await FB.getPlayersOnce();
      const humans = list.map(p => ({ uid: p.uid, name: p.name, joinedAt: p.joinedAt }));
      await Game.startMultiAsHost(FB.roomId, getPlayerName(), humans);
      attachGameHooks();
      showLoading(null);
      Game.runMainLoopAsHost();
    } catch (err) {
      showLoading(null);
      showError(humanizeError(err));
    }
  }

  /* ============================================================
     ゲーム開始 (ゲスト): meta.status が playing になった時
     ============================================================ */
  async function handleGuestGameStart() {
    if (ui.cleanupLobby) { try { ui.cleanupLobby(); } catch(_) {} ui.cleanupLobby = null; }
    showLoading('ゲームに参加中...', 'ホストの準備を待っています');
    try {
      await Game.joinAsGuest(FB.roomId, getPlayerName());
      attachGameHooks();
      showLoading(null);
    } catch (err) {
      showLoading(null);
      showError(humanizeError(err));
    }
  }

  /* ============================================================
     ソロモード開始
     ============================================================ */
  async function startSoloMode() {
    if (!AI.hasApiKey()) {
      showError('ソロプレイには Gemini APIキーが必要です。設定画面で入力してください。', '設定エラー');
      return;
    }
    showLoading('ゲームを準備中...', 'AIキャラクター6人を召喚しています');
    try {
      await Game.startSolo(getPlayerName());
      attachGameHooks();
      showLoading(null);
      Game.runMainLoopAsHost();
    } catch (err) {
      showLoading(null);
      showError(humanizeError(err));
    }
  }

  /* ============================================================
     Game フックを UI に接続
     ============================================================ */
  function attachGameHooks() {
    Game.setHooks({
      onPhaseChange: handlePhaseChange,
      onPlayersUpdate: handlePlayersUpdate,
      onHistoryUpdate: handleHistoryUpdate,
      onTimerTick: handleTimerTick,
      onSpeechAdded: handleSpeechAdded,
      onError: (err, ctx) => {
        if (ctx && ctx.recoverable) {
          toast('AI生成に失敗しました。フォールバックを使用します');
          return;
        }
        showError(humanizeError(err));
      },
      onResult: handleResult,
      onWaitProgress: handleWaitProgress,
      onRoleAssigned: handleRoleAssigned,
      onLoading: (msg, sub) => showLoading(msg, sub)
    });
  }

  /* ============================================================
     フェーズ変更ハンドラ
     ============================================================ */
  function handlePhaseChange(phase, data) {
    switch (phase) {
      case PHASES.CHARACTERS:
        renderCharacters();
        showScreen('characters');
        break;
      case PHASES.ROLE:
        renderRoleScreen();
        showScreen('role');
        break;
      case PHASES.NIGHT:
        renderNight(data);
        showScreen('night');
        break;
      case PHASES.MORNING:
        renderMorning(data);
        showScreen('morning');
        break;
      case PHASES.DISCUSSION:
        renderDiscussion(data);
        showScreen('discussion');
        break;
      case PHASES.VOTE:
        renderVote(data);
        showScreen('vote');
        break;
      case PHASES.EXECUTION:
        renderExecution(data);
        showScreen('execution');
        break;
      case PHASES.RESULT:
        renderResult();
        showScreen('result');
        break;
    }
  }

  function handlePlayersUpdate(players) {
    // 必要に応じて再描画 (現在の画面に応じて)
    if (ui.currentScreen === 'characters') renderCharacters();
    if (ui.currentScreen === 'discussion') updateMessageTargets();
  }

  function handleHistoryUpdate(history) {
    // 必要に応じて発言ログを再描画
    if (ui.currentScreen === 'morning') {
      renderMorningSpeeches();
    }
    if (ui.currentScreen === 'discussion') {
      // discussion ログには morning の発言を表示する
      renderDiscussionLog();
    }
  }

  function handleTimerTick(left) {
    const t = $('#discussionTimer');
    if (!t) return;
    t.textContent = GD.formatTime(left);
    t.classList.remove('warning', 'danger');
    if (left <= 10) t.classList.add('danger');
    else if (left <= 30) t.classList.add('warning');
  }

  function handleSpeechAdded(entry) {
    if (ui.currentScreen === 'morning') {
      renderMorningSpeeches();
    } else if (ui.currentScreen === 'discussion') {
      renderDiscussionLog();
    }
  }

  function handleWaitProgress(phaseKey, readyUids, expectedUids) {
    // ready-status 表示
    const map = {
      'characters': '#charactersReady',
      'role': '#roleReady'
    };
    let target = null;
    if (map[phaseKey]) target = $(map[phaseKey]);
    else if (phaseKey.startsWith('morning_')) target = $('#morningReady');
    else if (phaseKey.startsWith('discussion_')) target = $('#discussionReady');
    else if (phaseKey.startsWith('vote_')) target = $('#voteReady');
    if (target) {
      const total = expectedUids.length;
      const done = readyUids.length;
      target.textContent = `準備完了: ${done}/${total}`;
      target.classList.toggle('complete', done === total && total > 0);
    }
  }

  function handleRoleAssigned(role, info) {
    // role 画面の中身を埋める (ボタンを enable する側はクリック時)
    const def = ROLES[role];
    if (!def) return;
    $('#roleIcon').textContent = def.icon;
    $('#roleName').textContent = def.name;
    const teamDef = TEAMS[def.team];
    $('#roleTeam').textContent = teamDef.name;
    $('#roleTeam').className = 'role-team' + (def.team === 'werewolf' ? ' werewolf-team' : '');
    $('#roleDescription').textContent = def.description;
    const tm = info && info.teammateNames && info.teammateNames.length
      ? `相方の人狼: ${info.teammateNames.join('、')}`
      : '';
    $('#roleTeammates').textContent = tm;
    $('#roleCard').classList.toggle('werewolf', def.team === 'werewolf');
  }

  function handleResult(result) {
    renderResult();
    showScreen('result');
  }

  /* ============================================================
     キャラクター画面
     ============================================================ */
  function renderCharacters() {
    const grid = $('#characterGrid');
    grid.innerHTML = '';
    for (const p of Game.state.players) {
      const card = document.createElement('div');
      card.className = 'character-card' + (p.uid === Game.state.selfUid ? ' self' : '');
      if (p.kind === 'human') {
        card.innerHTML = `
          <div class="character-header">
            <span class="character-name">${GD.escapeHtml(p.displayName)}</span>
            <span class="character-kind human">人間</span>
          </div>
          <div class="character-meta">${p.uid === Game.state.selfUid ? 'あなた' : 'プレイヤー'}</div>
          <div class="character-catchphrase">月夜の村に集いし旅人</div>
        `;
      } else {
        const c = p.character || {};
        const tags = (c.personality_tags || []).map(t => `<span class="character-tag">${GD.escapeHtml(t)}</span>`).join('');
        card.innerHTML = `
          <div class="character-header">
            <span class="character-name">${GD.escapeHtml(p.displayName)}</span>
            <span class="character-kind ai">AI</span>
          </div>
          <div class="character-meta">${GD.escapeHtml(GD.formatAge(c.age))} / ${GD.escapeHtml(c.occupation || '')}</div>
          <div class="character-tags">${tags}</div>
          <div class="character-catchphrase">「${GD.escapeHtml(c.catchphrase || '')}」</div>
          <div class="character-background">${GD.escapeHtml(c.background || '')}</div>
        `;
      }
      grid.appendChild(card);
    }
    $('#charactersReady').textContent = '';
  }

  /* ============================================================
     役職画面
     ============================================================ */
  function renderRoleScreen() {
    const me = Game.self();
    if (!me) return;
    const role = me.role;
    const info = Game.buildHumanRoleInfo(me.uid);
    handleRoleAssigned(role, info);

    // カード未開封状態に戻す
    const card = $('#roleCard');
    card.classList.remove('flipped');
    $('#readyRoleBtn').disabled = true;
    $('#roleReady').textContent = '';
  }

  function flipRoleCard() {
    const card = $('#roleCard');
    if (card.classList.contains('flipped')) return;
    card.classList.add('flipped');
    $('#readyRoleBtn').disabled = false;
  }

  /* ============================================================
     夜画面
     ============================================================ */
  function renderNight(data) {
    const day = (data && data.day) || Game.state.day;
    $('#nightDayLabel').textContent = `DAY ${day}`;
    const me = Game.self();
    const action = $('#nightAction');
    const status = $('#nightStatus');
    action.innerHTML = '';
    status.textContent = '';
    ui.selectedNightTarget = null;

    if (!me || !me.alive) {
      status.textContent = '(あなたは亡くなっています。夜を見守ります...)';
      return;
    }

    const role = me.role;
    if (role === 'werewolf') {
      renderNightTargets(action, '襲撃する相手を選べ', '人狼として、村人を1人襲撃します', (cands) => {
        const teammateNames = (Game.buildHumanRoleInfo(me.uid).teammateNames) || [];
        return cands.filter(p => !teammateNames.includes(p.displayName));
      }, 'attack');
    } else if (role === 'seer') {
      // 既出の占い結果を表示
      const past = Game.buildHumanRoleInfo(me.uid).fortuneResults || [];
      if (past.length) {
        const last = past[past.length - 1];
        const div = document.createElement('div');
        div.className = 'fortune-result';
        div.innerHTML = `
          <div class="fortune-result-name">前回占い: ${GD.escapeHtml(last.targetName)}</div>
          <div class="fortune-result-verdict ${last.isWerewolf ? 'werewolf' : 'villager'}">
            → ${last.isWerewolf ? '人狼' : '村人(白)'}
          </div>`;
        action.appendChild(div);
      }
      renderNightTargets(action, '占う相手を選べ', '占い師として、相手の正体を見抜きます', (c) => c, 'fortune');
    } else if (role === 'knight') {
      renderNightTargets(action, '護衛する相手を選べ', '騎士として、人狼の襲撃から1人を守ります', (c) => c, 'guard');
    } else if (role === 'medium') {
      // 前日処刑された人の役職を表示 (Day 2 以降)
      const mr = Game.buildHumanRoleInfo(me.uid).mediumResults || [];
      if (mr.length) {
        const last = mr[mr.length - 1];
        const def = ROLES[last.role];
        const div = document.createElement('div');
        div.className = 'medium-result';
        div.innerHTML = `
          <div class="medium-result-name">処刑者: ${GD.escapeHtml(last.name)}</div>
          <div class="medium-result-role ${last.role === 'werewolf' ? 'werewolf' : ''}">
            → 役職: ${def ? def.name : last.role}
          </div>`;
        action.appendChild(div);
      } else {
        const div = document.createElement('div');
        div.className = 'night-action-desc';
        div.textContent = '霊媒師は、前日に処刑された者の役職を視ます。(初日はまだ霊視対象がいません)';
        action.appendChild(div);
      }
      status.textContent = '夜が更けるのを待っています...';
      // 自動で「アクション完了」とする
      Game.submitNightAction({ type: 'medium', targetUid: null });
    } else {
      // villager
      const div = document.createElement('div');
      div.className = 'night-action-desc';
      div.textContent = 'あなたは村人です。夜は静かに眠りについてください。';
      action.appendChild(div);
      status.textContent = '夜が更けるのを待っています...';
      Game.submitNightAction({ type: 'sleep', targetUid: null });
    }
  }

  function renderNightTargets(container, title, desc, filterFn, actionType) {
    const titleEl = document.createElement('div');
    titleEl.className = 'night-action-title';
    titleEl.textContent = title;
    container.appendChild(titleEl);
    const descEl = document.createElement('div');
    descEl.className = 'night-action-desc';
    descEl.textContent = desc;
    container.appendChild(descEl);

    const me = Game.self();
    let cands = Game.aliveExcept(me.uid);
    cands = filterFn(cands);

    const grid = document.createElement('div');
    grid.className = 'night-action-grid';
    for (const p of cands) {
      const btn = document.createElement('button');
      btn.className = 'target-btn';
      btn.dataset.uid = p.uid;
      btn.innerHTML = `${GD.escapeHtml(p.displayName)}<span class="target-sub">${p.kind === 'ai' ? 'AI' : '人間'}</span>`;
      btn.addEventListener('click', () => {
        $$('.target-btn', grid).forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        ui.selectedNightTarget = p.uid;
      });
      grid.appendChild(btn);
    }
    container.appendChild(grid);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn btn-primary w-full';
    confirmBtn.style.marginTop = '20px';
    confirmBtn.textContent = '決定';
    confirmBtn.addEventListener('click', async () => {
      if (!ui.selectedNightTarget) {
        toast('対象を選んでください');
        return;
      }
      const target = Game.findByUid(ui.selectedNightTarget);
      if (!target) return;
      confirmBtn.disabled = true;
      $$('.target-btn', grid).forEach(b => b.disabled = true);
      $('#nightStatus').textContent = `${target.displayName} を ${
        actionType === 'attack' ? '襲撃' : actionType === 'fortune' ? '占い' : '護衛'
      }対象に決定しました。他のプレイヤー / AI を待っています...`;
      await Game.submitNightAction({ type: actionType, targetUid: target.uid, targetName: target.displayName });
    });
    container.appendChild(confirmBtn);
  }

  /* ============================================================
     朝画面
     ============================================================ */
  function renderMorning(data) {
    const day = (data && data.day) || Game.state.day;
    $('#morningDayLabel').textContent = `DAY ${day}`;
    const hist = Game.state.history.find(h => h.day === day) || {};
    const ar = $('#attackResult');
    ar.innerHTML = '';
    if (day === 1) {
      ar.className = 'attack-result peace';
      ar.innerHTML = `
        <div class="attack-title">— 月夜の始まり —</div>
        <div class="attack-name">静かな夜だった</div>
        <div class="attack-desc">村に異変はなかった。これから人狼の影が忍び寄る...</div>`;
    } else if (hist.attackedName) {
      ar.className = 'attack-result';
      ar.innerHTML = `
        <div class="attack-title">— 襲撃 —</div>
        <div class="attack-name">${GD.escapeHtml(hist.attackedName)}</div>
        <div class="attack-desc">人狼に喰い殺された姿で発見された...</div>`;
    } else {
      ar.className = 'attack-result peace';
      ar.innerHTML = `
        <div class="attack-title">— 静寂の朝 —</div>
        <div class="attack-name">誰も亡くならなかった</div>
        <div class="attack-desc">騎士の加護が村を守ったのかもしれない...</div>`;
    }
    ui.morningSpeechesShown = 0;
    renderMorningSpeeches();
    $('#readyMorningBtn').hidden = false;
    $('#morningReady').textContent = '';
  }

  function renderMorningSpeeches() {
    const day = Game.state.day;
    const hist = Game.state.history.find(h => h.day === day);
    const wrap = $('#morningSpeeches');
    wrap.innerHTML = '';
    if (!hist || !hist.morningSpeeches) return;
    for (const s of hist.morningSpeeches) {
      wrap.appendChild(speechBubbleEl(s));
    }
  }

  function speechBubbleEl(s) {
    const me = Game.self();
    const isSelf = me && s.uid === me.uid;
    const isError = !!s.error;
    const div = document.createElement('div');
    div.className = 'speech-bubble' + (isSelf ? ' self' : '') + (isError ? ' error' : '');
    const speaker = Game.findByUid(s.uid);
    const dead = speaker && !speaker.alive;
    if (dead) div.classList.add('dead');
    const meta = (speaker && speaker.kind === 'ai') ? '<span class="speech-speaker-meta">AI</span>' : '';
    div.innerHTML = `
      <div class="speech-speaker">${GD.escapeHtml(s.name)}${meta}</div>
      <div class="speech-text">${GD.escapeHtml(s.speech)}</div>`;
    return div;
  }

  /* ============================================================
     議論画面
     ============================================================ */
  function renderDiscussion(data) {
    const day = (data && data.day) || Game.state.day;
    $('#discussionDayLabel').textContent = `DAY ${day}`;
    const me = Game.self();
    const totalSec = (me && me.alive) ? CONFIG.DISCUSSION_TIME_SEC : CONFIG.DISCUSSION_TIME_DEAD_SEC;
    $('#discussionTimer').textContent = GD.formatTime(totalSec);
    $('#discussionTimer').classList.remove('warning', 'danger');

    const dead = !me || !me.alive;
    $('#messageInputArea').hidden = dead;
    $('#spectatorNotice').hidden = !dead;
    $('#readyDiscussionBtn').textContent = dead ? '次へ' : '議論を終えて投票へ';

    ui.sentMessages = [];
    $('#sentMessages').innerHTML = '';
    $('#messageTextInput').value = '';
    $('#messageCharCount').textContent = '0';
    $('#discussionReady').textContent = '';

    updateMessageTargets();
    renderDiscussionLog();
  }

  function updateMessageTargets() {
    const sel = $('#messageTargetSelect');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '';
    const ais = Game.aiPlayers().filter(p => p.alive);
    if (ais.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '送信先のAIがいません';
      sel.appendChild(opt);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    for (const ai of ais) {
      const opt = document.createElement('option');
      opt.value = ai.uid;
      opt.textContent = ai.displayName;
      sel.appendChild(opt);
    }
    if (cur && Array.from(sel.options).some(o => o.value === cur)) sel.value = cur;
  }

  function renderDiscussionLog() {
    const wrap = $('#discussionLog');
    if (!wrap) return;
    wrap.innerHTML = '';
    const day = Game.state.day;
    const hist = Game.state.history.find(h => h.day === day);
    if (!hist || !hist.morningSpeeches) {
      const div = document.createElement('div');
      div.className = 'speech-bubble';
      div.innerHTML = `<div class="speech-text">議論をお始めください...</div>`;
      wrap.appendChild(div);
      return;
    }
    for (const s of hist.morningSpeeches) {
      wrap.appendChild(speechBubbleEl(s));
    }
    if (ui.discussionScrollPinned) wrap.scrollTop = wrap.scrollHeight;
  }

  async function sendMessage() {
    const sel = $('#messageTargetSelect');
    const text = $('#messageTextInput').value.trim();
    if (!sel.value) { toast('送信先を選んでください'); return; }
    if (!text) { toast('伝言を入力してください'); return; }
    const target = Game.findByUid(sel.value);
    if (!target) return;
    try {
      await Game.sendMessageToAi(sel.value, text);
      $('#messageTextInput').value = '';
      $('#messageCharCount').textContent = '0';
      const div = document.createElement('div');
      div.className = 'sent-message';
      div.innerHTML = `<div class="sent-message-to">→ ${GD.escapeHtml(target.displayName)}</div><div class="sent-message-text">${GD.escapeHtml(text)}</div>`;
      $('#sentMessages').appendChild(div);
      toast('伝言を送信しました');
    } catch (e) {
      showError(humanizeError(e));
    }
  }

  /* ============================================================
     投票画面
     ============================================================ */
  function renderVote(data) {
    const day = (data && data.day) || Game.state.day;
    $('#voteDayLabel').textContent = `DAY ${day}`;
    const me = Game.self();
    const dead = !me || !me.alive;
    $('#voteSpectator').hidden = !dead;
    const grid = $('#voteGrid');
    grid.innerHTML = '';
    ui.selectedVoteTarget = null;
    $('#confirmVoteBtn').disabled = true;
    $('#voteReady').textContent = '';

    if (dead) {
      $('#confirmVoteBtn').hidden = true;
      return;
    }
    $('#confirmVoteBtn').hidden = false;

    const cands = Game.aliveExcept(me.uid);
    for (const p of cands) {
      const btn = document.createElement('button');
      btn.className = 'vote-btn';
      btn.dataset.uid = p.uid;
      btn.innerHTML = `${GD.escapeHtml(p.displayName)}<span class="vote-sub">${p.kind === 'ai' ? 'AI' : '人間'}</span>`;
      btn.addEventListener('click', () => {
        $$('.vote-btn', grid).forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        ui.selectedVoteTarget = p.uid;
        $('#confirmVoteBtn').disabled = false;
      });
      grid.appendChild(btn);
    }
  }

  async function confirmVote() {
    if (!ui.selectedVoteTarget) return;
    $('#confirmVoteBtn').disabled = true;
    $$('.vote-btn').forEach(b => b.disabled = true);
    const target = Game.findByUid(ui.selectedVoteTarget);
    toast(`${target ? target.displayName : '?'} に投票しました`);
    await Game.submitHumanVote(ui.selectedVoteTarget);
  }

  /* ============================================================
     処刑画面
     ============================================================ */
  function renderExecution(data) {
    const day = (data && data.day) || Game.state.day;
    $('#executionDayLabel').textContent = `DAY ${day}`;

    const detail = $('#voteDetail');
    detail.innerHTML = '';
    const dt = document.createElement('div');
    dt.className = 'vote-detail-title';
    dt.textContent = '投票内訳';
    detail.appendChild(dt);
    const votes = (data && data.votes) || [];
    for (const v of votes) {
      const row = document.createElement('div');
      row.className = 'vote-detail-item';
      row.innerHTML = `
        <span class="vote-detail-from">${GD.escapeHtml(v.fromName)}</span>
        <span class="vote-detail-arrow">→</span>
        <span class="vote-detail-to">${GD.escapeHtml(v.toName || '無投票')}</span>`;
      detail.appendChild(row);
    }

    const summary = $('#voteSummary');
    summary.innerHTML = '';
    const st = document.createElement('div');
    st.className = 'vote-summary-title';
    st.textContent = '集計';
    summary.appendChild(st);
    const counts = (data && data.voteCounts) || {};
    let topCount = 0;
    for (const v of Object.values(counts)) if (v > topCount) topCount = v;
    const arr = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    for (const [uid, c] of arr) {
      const p = Game.findByUid(uid);
      const row = document.createElement('div');
      row.className = 'vote-summary-item' + (c === topCount ? ' top' : '');
      row.innerHTML = `
        <span class="vote-summary-name">${GD.escapeHtml(p ? p.displayName : '?')}</span>
        <span class="vote-summary-count">${c}票</span>`;
      summary.appendChild(row);
    }

    const result = $('#executionResult');
    if (data && data.executedName) {
      result.className = 'execution-result';
      result.innerHTML = `
        <div class="execution-result-label">— 処刑 —</div>
        <div class="execution-result-name">${GD.escapeHtml(data.executedName)}</div>`;
    } else {
      result.className = 'execution-result peace';
      result.innerHTML = `
        <div class="execution-result-label">— 処刑なし —</div>
        <div class="execution-result-name">投票が割れた</div>`;
    }
    $('#executionStatus').textContent = '夜が訪れる...';
  }

  /* ============================================================
     結果画面
     ============================================================ */
  function renderResult() {
    const r = Game.state.result || { winner: 'villager', reason: '' };
    const def = TEAMS[r.winner];
    const win = $('#resultWinner');
    win.className = 'result-winner ' + r.winner;
    win.textContent = def ? def.name + ' 勝利' : '';
    $('#resultReason').textContent = r.reason || '';

    const wrap = $('#resultRoles');
    wrap.innerHTML = '';
    for (const p of Game.state.players) {
      const def = ROLES[p.role];
      const row = document.createElement('div');
      row.className = 'result-role-item' + (p.alive ? '' : ' dead');
      row.innerHTML = `
        <span class="player-name">${GD.escapeHtml(p.displayName)} <span style="color:var(--color-text-dimmer);font-size:11px;">(${p.kind === 'ai' ? 'AI' : '人間'})</span></span>
        <span class="role-label ${p.role === 'werewolf' ? 'werewolf' : ''}">${def ? def.name : p.role}</span>`;
      wrap.appendChild(row);
    }
  }

  /* ============================================================
     裏の思考ログ画面
     ============================================================ */
  function renderThoughtLog() {
    const wrap = $('#thoughtLog');
    wrap.innerHTML = '';
    const log = Game.getThoughtLog();
    if (!log.length) {
      wrap.innerHTML = '<p class="text-center text-dim">思考ログはありません</p>';
      return;
    }
    for (const e of log) {
      const def = ROLES[e.role];
      const card = document.createElement('div');
      card.className = 'thought-entry';
      const header = `
        <div class="thought-entry-header">
          <span class="thought-entry-name">${GD.escapeHtml(e.name)}</span>
          <span class="thought-entry-role ${e.role === 'werewolf' ? 'werewolf' : ''}">${def ? def.name : e.role}</span>
        </div>`;
      let body = '';
      const dayKeys = Object.keys(e.days).sort((a, b) => Number(a) - Number(b));
      for (const dk of dayKeys) {
        const items = e.days[dk];
        let inner = '';
        for (const it of items) {
          const kindMap = { morning: '朝の発言', vote: '投票', attack: '襲撃', fortune: '占い', guard: '護衛' };
          inner += `<div class="thought-text"><b style="color:var(--color-accent)">[${kindMap[it.kind] || it.kind}]</b> ${GD.escapeHtml(it.text)}</div>`;
        }
        body += `<div class="thought-day-section">
          <div class="thought-day-label">DAY ${dk}</div>
          ${inner}
        </div>`;
      }
      card.innerHTML = header + body;
      wrap.appendChild(card);
    }
  }

  /* ============================================================
     ゲスト用: フェーズ毎の自動アクション
     - night/discussion/vote/morning でゲスト固有のローカル送信を扱う
     ============================================================ */
  // ※ guest mode の night/vote/discussion ボタン押下は同じハンドラ
  //    (Game.submitNightAction, Game.submitHumanVote, Game.markReady)
  //    を経由するので追加処理は不要

  /* ============================================================
     イベントバインディング
     ============================================================ */
  function bindEvents() {
    document.body.addEventListener('click', async (ev) => {
      const target = ev.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      switch (action) {
        case 'start': {
          showScreen('mode');
          break;
        }
        case 'goto-settings':
          loadStoredSettings();
          showScreen('settings');
          break;
        case 'goto-title':
          showScreen('title');
          break;
        case 'goto-mode':
          showScreen('mode');
          break;
        case 'save-settings':
          saveSettings();
          break;
        case 'mode-solo':
          startSoloMode();
          break;
        case 'mode-multi':
          showScreen('room');
          break;
        case 'create-room':
          createRoom();
          break;
        case 'join-room':
          joinRoom();
          break;
        case 'leave-room':
          leaveRoom();
          break;
        case 'copy-room-id':
          copyRoomId();
          break;
        case 'start-game':
          startGameAsHost();
          break;
        case 'ready-characters':
          $('#charactersReady').textContent = '準備完了 ✓';
          $('#readyCharactersBtn').disabled = true;
          await Game.markReady('characters');
          if (Game.state.mode === 'solo') {
            // 即座に役職画面へ
            // (Game.runMainLoopAsHost 内の transitionLocalPhase に頼るので、ここでは何もしない)
            // ただしソロでは ready 待ちがないので main loop は次へ進む
            // → wait は multi のみなので、ソロは即時 setPhase が走る
            // ホスト処理が CHARACTERS で止まらないように、ここで手動で次へ進ませる必要がある
            // 設計上、host loop は wait しないので進む。問題なし。
          }
          break;
        case 'ready-role':
          $('#roleReady').textContent = '準備完了 ✓';
          $('#readyRoleBtn').disabled = true;
          await Game.markReady('role');
          break;
        case 'ready-morning':
          $('#morningReady').textContent = '準備完了 ✓';
          $('#readyMorningBtn').disabled = true;
          await Game.markReady('morning_d' + Game.state.day);
          if (Game.state.mode === 'solo') {
            // ソロ: 朝の表示後、自動で discussion へ進む
            // (host main loop は人間 ready を multi のみで待つ。ソロはそのまま先へ)
          }
          break;
        case 'ready-discussion':
          $('#discussionReady').textContent = '準備完了 ✓';
          target.disabled = true;
          await Game.markReady('discussion_d' + Game.state.day);
          if (Game.state.mode === 'solo') {
            Game.endDiscussionEarlyLocal();
          }
          break;
        case 'send-message':
          sendMessage();
          break;
        case 'confirm-vote':
          confirmVote();
          if (Game.state.mode === 'multi') {
            await Game.markReady('vote_d' + Game.state.day);
          }
          break;
        case 'play-again':
          await fullReset();
          showScreen('title');
          break;
        case 'view-thoughts':
          renderThoughtLog();
          showScreen('thought-log');
          break;
        case 'back-to-result':
          showScreen('result');
          break;
        case 'close-error':
          closeError();
          break;
      }
    });

    // 役職カードをタップで開く
    document.body.addEventListener('click', (ev) => {
      if (ev.target.closest('#roleCard')) flipRoleCard();
    });
    document.body.addEventListener('keydown', (ev) => {
      if (ev.target.id === 'roleCard' && (ev.key === 'Enter' || ev.key === ' ')) {
        ev.preventDefault();
        flipRoleCard();
      }
    });

    // 伝言文字数カウンタ
    const ti = $('#messageTextInput');
    if (ti) {
      ti.addEventListener('input', () => {
        const v = ti.value;
        if (v.length > CONFIG.MESSAGE_MAX_LENGTH) {
          ti.value = v.slice(0, CONFIG.MESSAGE_MAX_LENGTH);
        }
        $('#messageCharCount').textContent = String(ti.value.length);
      });
    }

    // 議論ログのスクロール状態を保持
    const dl = $('#discussionLog');
    if (dl) {
      dl.addEventListener('scroll', () => {
        const nearBottom = dl.scrollTop + dl.clientHeight >= dl.scrollHeight - 12;
        ui.discussionScrollPinned = nearBottom;
      });
    }

    // 数字のみのルームID入力
    const rid = $('#roomIdInput');
    if (rid) {
      rid.addEventListener('input', () => {
        rid.value = rid.value.replace(/[^0-9]/g, '').slice(0, 6);
      });
    }
  }

  async function fullReset() {
    Game.reset();
    if (FB.roomId) {
      try { await FB.leaveRoom(); } catch(_) {}
    }
    try { FB.detachAll(); } catch(_) {}
    ui.cleanupLobby = null;
  }

  /* ============================================================
     初期化
     ============================================================ */
  function init() {
    bindEvents();
    loadStoredSettings();

    // Firebase 初期化を待ってから AuthOnly はせずに、必要なときに initAuth を呼ぶ
    FB.waitForFirebase().catch(() => {});

    showScreen('title');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
