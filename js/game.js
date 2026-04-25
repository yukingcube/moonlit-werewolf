/* ============================================================
   js/game.js
   ゲームのコアロジック / 状態遷移 / AI制御 / 勝敗判定
   ソロモードとマルチモード(ホスト/ゲスト)の両方を扱う
   ============================================================ */
'use strict';

(function() {
  const GD = window.GameData;
  const AI = window.AI;
  const FB = window.FirebaseAPI;
  const { CONFIG, ROLES, TEAMS, PHASES } = GD;

  /* ============================================================
     state
     ============================================================ */
  const state = {
    mode: null,          // 'solo' | 'multi'
    isHost: false,
    selfUid: null,
    selfName: null,
    players: [],         // [{ uid, name, displayName, kind: 'human'|'ai', alive, character, role, joinedAt }]
    day: 0,
    phase: null,
    phaseData: null,
    phaseVersion: 0,
    history: [],         // [{ day, attackedName, attackedUid, morningSpeeches:[{uid,name,speech,thought,error}], votes:[{fromUid,fromName,toUid,toName}], executedUid, executedName, executedRole, peace }]
    result: null,        // { winner, reason }
    aiBrains: {},        // uid -> { roleInfo, character }
    thoughts: {},        // uid -> [{ day, kind, text }]
    messagesByDay: {},   // day -> [{ fromUid, fromName, targetUid, text }]
    discussionTimerId: null,
    discussionEndsAt: 0,
    voteSelections: {},  // uid -> targetUid (for current day)
    nightActions: {},    // uid -> { type, target }
    started: false
  };

  /* ============================================================
     hooks (UI からのコールバック登録)
     ============================================================ */
  const hooks = {
    onPhaseChange: null,         // (phase, data) => void
    onPlayersUpdate: null,       // (players) => void
    onHistoryUpdate: null,       // (history) => void
    onTimerTick: null,           // (secondsLeft) => void
    onError: null,               // (err, ctx) => void
    onSpeechAdded: null,         // (entry) => void
    onMessageReceived: null,     // (msg) => void
    onResult: null,              // (result) => void
    onWaitProgress: null,        // (phaseKey, readyUids, expectedUids) => void
    onRoleAssigned: null,        // (myRole, roleInfo) => void
    onLoading: null              // (msgOrNull, sub) => void
  };

  function setHooks(partial) {
    Object.assign(hooks, partial || {});
  }
  function emit(name, ...args) {
    const fn = hooks[name];
    if (typeof fn === 'function') {
      try { fn(...args); } catch(e) { console.error('hook error', name, e); }
    }
  }
  function loading(msg, sub) {
    emit('onLoading', msg || null, sub || '');
  }
  function reportError(err, ctx) {
    console.error('[Game error]', ctx, err);
    emit('onError', err, ctx);
  }

  /* ============================================================
     accessors
     ============================================================ */
  function self() { return state.players.find(p => p.uid === state.selfUid) || null; }
  function alive() { return state.players.filter(p => p.alive); }
  function aliveExcept(uid) { return state.players.filter(p => p.alive && p.uid !== uid); }
  function aiPlayers() { return state.players.filter(p => p.kind === 'ai'); }
  function humanPlayers() { return state.players.filter(p => p.kind === 'human'); }
  function findByUid(uid) { return state.players.find(p => p.uid === uid) || null; }
  function findByDisplayName(name) { return state.players.find(p => p.displayName === name) || null; }

  /* ============================================================
     初期化 / リセット
     ============================================================ */
  function reset() {
    if (state.discussionTimerId) {
      clearInterval(state.discussionTimerId);
      state.discussionTimerId = null;
    }
    state.mode = null;
    state.isHost = false;
    state.selfUid = null;
    state.selfName = null;
    state.players = [];
    state.day = 0;
    state.phase = null;
    state.phaseData = null;
    state.phaseVersion = 0;
    state.history = [];
    state.result = null;
    state.aiBrains = {};
    state.thoughts = {};
    state.messagesByDay = {};
    state.discussionEndsAt = 0;
    state.voteSelections = {};
    state.nightActions = {};
    state.started = false;
    state._localReady = {};
  }

  /* ============================================================
     ロール配布 (仕様書 ROLE_COUNTS)
     ============================================================ */
  function assignRoles(players) {
    const pool = GD.shuffleArray(GD.buildRolePool());
    if (pool.length !== players.length) {
      throw new Error(`ROLE_POOL_MISMATCH: pool=${pool.length}, players=${players.length}`);
    }
    return players.map((p, i) => ({ ...p, role: pool[i] }));
  }

  /* ============================================================
     AI ブレイン構築 (各AIキャラの内部状態)
     ============================================================ */
  function buildAiBrain(player, allPlayers) {
    const roleInfo = {};
    if (player.role === 'werewolf') {
      const teammates = allPlayers
        .filter(p => p.role === 'werewolf' && p.uid !== player.uid)
        .map(p => p.displayName);
      roleInfo.teammateNames = teammates;
      roleInfo.bluff = AI.decideBluffStrategy(player.character);
    } else if (player.role === 'seer') {
      roleInfo.fortuneResults = [];
    } else if (player.role === 'medium') {
      roleInfo.mediumResults = [];
    }
    return { character: player.character, roleInfo };
  }

  function rebuildAllAiBrains() {
    state.aiBrains = {};
    const ais = aiPlayers();
    for (const p of ais) {
      state.aiBrains[p.uid] = buildAiBrain(p, state.players);
    }
  }

  /* ============================================================
     人間プレイヤー用の魂(roleInfo)を組み立てる
     ============================================================ */
  function buildHumanRoleInfo(playerUid) {
    const me = findByUid(playerUid);
    if (!me) return {};
    const info = {};
    if (me.role === 'werewolf') {
      const teammates = state.players
        .filter(p => p.role === 'werewolf' && p.uid !== me.uid)
        .map(p => p.displayName);
      info.teammateNames = teammates;
    } else if (me.role === 'seer') {
      info.fortuneResults = collectFortuneHistory(me.uid);
    } else if (me.role === 'medium') {
      info.mediumResults = collectMediumHistory();
    }
    return info;
  }

  function collectFortuneHistory(seerUid) {
    const out = [];
    for (const d of state.history) {
      if (d.fortuneResultsBy && d.fortuneResultsBy[seerUid]) {
        out.push(d.fortuneResultsBy[seerUid]);
      }
    }
    return out;
  }
  function collectMediumHistory() {
    const out = [];
    for (const d of state.history) {
      if (d.executedUid && d.executedRole) {
        const p = findByUid(d.executedUid);
        out.push({ day: d.day, name: p ? p.displayName : d.executedName, role: d.executedRole });
      }
    }
    return out;
  }

  /* ============================================================
     thought log 蓄積
     ============================================================ */
  function recordThought(uid, day, kind, text) {
    if (!text) return;
    if (!state.thoughts[uid]) state.thoughts[uid] = [];
    state.thoughts[uid].push({ day, kind, text });
  }

  /* ============================================================
     コンテキスト構築 (AI 用 ctx)
     ============================================================ */
  function buildCtx(aiPlayer, opts = {}) {
    const brain = state.aiBrains[aiPlayer.uid];
    if (!brain) throw new Error('AI brain not found: ' + aiPlayer.uid);

    let roleInfo = GD.deepClone(brain.roleInfo || {});
    if (aiPlayer.role === 'seer') {
      roleInfo.fortuneResults = collectFortuneHistory(aiPlayer.uid);
    } else if (aiPlayer.role === 'medium') {
      roleInfo.mediumResults = collectMediumHistory();
    }

    // メッセージは前日の議論で送られたものと当日のものを合算
    const msgDays = opts.messageDays || [state.day - 1, state.day];
    const msgsAll = [];
    for (const d of msgDays) {
      const arr = state.messagesByDay[d] || [];
      for (const m of arr) {
        if (m.targetUid === aiPlayer.uid) msgsAll.push(m);
      }
    }
    const messagesToday = msgsAll.map(m => ({ fromName: m.fromName || '', text: m.text || '' }));

    const todayHist = state.history.find(h => h.day === state.day);
    const todayAttackedName = todayHist ? (todayHist.attackedName || null) : null;

    const todayMorningSpeeches = todayHist && todayHist.morningSpeeches
      ? todayHist.morningSpeeches.map(s => ({ name: s.name, speech: s.speech }))
      : [];

    const playersForCtx = state.players.map(p => ({
      uid: p.uid,
      displayName: p.displayName,
      kind: p.kind,
      alive: p.alive
    }));

    return {
      day: state.day,
      self: {
        uid: aiPlayer.uid,
        displayName: aiPlayer.displayName,
        character: aiPlayer.character,
        role: aiPlayer.role
      },
      roleInfo,
      players: playersForCtx,
      history: state.history.map(h => ({
        day: h.day,
        attackedName: h.attackedName,
        morningSpeeches: (h.morningSpeeches || []).map(s => ({ name: s.name, speech: s.speech })),
        votes: (h.votes || []).map(v => ({ fromName: v.fromName, toName: v.toName })),
        executedName: h.executedName,
        executedRole: h.executedRole
      })),
      todayAttackedName,
      todayMorningSpeeches,
      messagesToday,
      ...opts
    };
  }

  /* ============================================================
     勝敗判定 (仕様書: 人狼0 → 村人勝利 / 人狼≧村人 → 人狼勝利)
     ============================================================ */
  function checkWinner() {
    const wolves = state.players.filter(p => p.alive && p.role === 'werewolf').length;
    const villagers = state.players.filter(p => p.alive && p.role !== 'werewolf').length;
    if (wolves === 0) return { winner: 'villager', reason: '人狼を全員処刑しました' };
    if (wolves >= villagers) return { winner: 'werewolf', reason: '人狼の数が村人と並びました' };
    if (state.day >= CONFIG.MAX_DAY) return { winner: 'werewolf', reason: `${CONFIG.MAX_DAY}日経過: 人狼陣営の勝利` };
    return null;
  }

  /* ============================================================
     キャラクター生成 (host のみ)
     ============================================================ */
  async function generateAllCharacters(humanPlayersList) {
    const totalAi = CONFIG.TOTAL_PLAYERS - humanPlayersList.length;
    if (totalAi <= 0) return { humans: humanPlayersList.map(h => ({ ...h, character: null })), ais: [] };

    loading('AIキャラクターを召喚中...', 'Gemini APIで12人分の魂を紡いでいます');

    const generated = await AI.generateCharactersSafe(totalAi, (err) => {
      console.warn('character generation fallback', err);
      emit('onError', err, { phase: 'characters', recoverable: true });
    });

    const aiPlayersList = [];
    for (let i = 0; i < totalAi; i++) {
      const ch = generated[i];
      const uid = 'ai_' + GD.makeUid().slice(6);
      aiPlayersList.push({
        uid,
        name: ch.name,
        kind: 'ai',
        character: ch,
        joinedAt: Date.now() + i,
        alive: true
      });
    }

    const humans = humanPlayersList.map((h, i) => ({
      uid: h.uid,
      name: h.name,
      kind: 'human',
      character: null,
      joinedAt: h.joinedAt || (Date.now() + i),
      alive: true
    }));

    return { humans, ais: aiPlayersList };
  }

  /* ============================================================
     プレイヤー初期化 (名前重複対応)
     ============================================================ */
  function finalizePlayers(humans, ais) {
    let combined = humans.concat(ais);
    combined = GD.disambiguateNames(combined);
    return combined;
  }

  /* ============================================================
     ★ ソロモード ★
     ============================================================ */
  async function startSolo(playerName) {
    reset();
    state.mode = 'solo';
    state.isHost = true;
    state.selfUid = 'human_' + GD.makeUid().slice(6);
    state.selfName = playerName;

    const humans = [{ uid: state.selfUid, name: playerName, joinedAt: Date.now() }];
    const { humans: hs, ais } = await generateAllCharacters(humans);
    state.players = finalizePlayers(hs, ais);
    state.players = assignRoles(state.players);
    rebuildAllAiBrains();
    state.started = true;
    loading(null);

    emit('onPlayersUpdate', state.players);

    // → キャラ表示画面
    await transitionLocalPhase(PHASES.CHARACTERS);
  }

  /* ============================================================
     ★ マルチモード(ホスト) ★
     1) ロビー画面でゲーム開始押下時に呼ばれる
     ============================================================ */
  async function startMultiAsHost(roomId, playerName, allHumans) {
    reset();
    state.mode = 'multi';
    state.isHost = true;
    state.selfUid = FB.uid;
    state.selfName = playerName;

    // human players (from lobby)
    const humansList = allHumans.map(h => ({
      uid: h.uid, name: h.name, joinedAt: h.joinedAt || Date.now()
    }));
    const { humans: hs, ais } = await generateAllCharacters(humansList);
    let combined = finalizePlayers(hs, ais);
    combined = assignRoles(combined);
    state.players = combined;
    rebuildAllAiBrains();
    state.started = true;

    // Firebase に書き込み (各ゲストにも見える形で)
    loading('ゲームデータを共有中...');
    const playersForDb = {};
    for (const p of state.players) {
      playersForDb[p.uid] = {
        uid: p.uid,
        name: p.name,
        displayName: p.displayName,
        kind: p.kind,
        alive: true,
        character: p.character || null,
        joinedAt: p.joinedAt
      };
    }

    const F = window.__FB;
    await F.set(F.ref(F.db, `rooms/${roomId}/gamePlayers`), playersForDb);

    // 役職は uid 別に書き込み (各人は自分の役職のみ読める想定)
    const rolesByUid = {};
    for (const p of state.players) {
      rolesByUid[p.uid] = {
        role: p.role,
        teammateNames: p.role === 'werewolf'
          ? state.players.filter(x => x.role === 'werewolf' && x.uid !== p.uid).map(x => x.displayName)
          : []
      };
    }
    await FB.setAllRoles(rolesByUid);
    await FB.setMetaStatus('playing');

    loading(null);
    await transitionMultiPhase(PHASES.CHARACTERS);
  }

  /* ============================================================
     ★ マルチモード(ゲスト) ★
     ============================================================ */
  async function joinAsGuest(roomId, playerName) {
    reset();
    state.mode = 'multi';
    state.isHost = false;
    state.selfUid = FB.uid;
    state.selfName = playerName;
    state.started = true;

    // gamePlayers と game(phase) を listen
    const F = window.__FB;
    const playersSnap = await F.get(F.ref(F.db, `rooms/${roomId}/gamePlayers`));
    if (playersSnap.exists()) {
      ingestPlayersFromDb(playersSnap.val());
    }

    F.onValue(F.ref(F.db, `rooms/${roomId}/gamePlayers`), (snap) => {
      const v = snap.val();
      if (v) ingestPlayersFromDb(v);
    });

    state._pendingRoleData = null;
    FB.listenMyRole((roleData) => {
      if (!roleData) return;
      state._pendingRoleData = roleData;
      const me = self();
      if (me) {
        me.role = roleData.role;
        const info = {};
        if (roleData.role === 'werewolf') info.teammateNames = roleData.teammateNames || [];
        emit('onRoleAssigned', roleData.role, info);
      }
    });

    FB.listenGame((g) => {
      if (!g) return;
      handleGameUpdate(g);
    });
  }

  function ingestPlayersFromDb(playersData) {
    const list = [];
    for (const [uid, p] of Object.entries(playersData)) {
      list.push({
        uid,
        name: p.name,
        displayName: p.displayName || p.name,
        kind: p.kind,
        alive: !!p.alive,
        character: p.character || null,
        role: p.role || null,
        joinedAt: p.joinedAt || 0
      });
    }
    list.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    state.players = list;
    // 保留中のロール情報があれば反映
    if (state._pendingRoleData) {
      const me = self();
      if (me) {
        me.role = state._pendingRoleData.role;
        const info = {};
        if (state._pendingRoleData.role === 'werewolf') {
          info.teammateNames = state._pendingRoleData.teammateNames || [];
        }
        emit('onRoleAssigned', state._pendingRoleData.role, info);
      }
    }
    emit('onPlayersUpdate', state.players);
  }

  function handleGameUpdate(g) {
    if (typeof g.phaseVersion === 'number' && g.phaseVersion <= state.phaseVersion) return;
    state.phaseVersion = g.phaseVersion || 0;
    state.phase = g.phase || state.phase;
    state.phaseData = g.phaseData || null;

    // history / day / players(alive,role) 同期
    if (g.phaseData) {
      if (typeof g.phaseData.day === 'number') state.day = g.phaseData.day;
      if (Array.isArray(g.phaseData.history)) state.history = g.phaseData.history;
      if (g.phaseData.alive) {
        for (const [uid, alive] of Object.entries(g.phaseData.alive)) {
          const p = findByUid(uid);
          if (p) p.alive = !!alive;
        }
      }
      if (g.phaseData.rolesReveal) {
        for (const [uid, role] of Object.entries(g.phaseData.rolesReveal)) {
          const p = findByUid(uid);
          if (p) p.role = role;
        }
      }
    }
    if (g.result) {
      state.result = g.result;
    }

    emit('onPlayersUpdate', state.players);
    emit('onHistoryUpdate', state.history);
    emit('onPhaseChange', state.phase, state.phaseData || null);
    if (g.result) emit('onResult', g.result);
  }

  /* ============================================================
     フェーズ遷移 (ローカル / マルチ)
     ============================================================ */
  async function transitionLocalPhase(phase, data = null) {
    state.phase = phase;
    state.phaseData = data;
    emit('onPhaseChange', phase, data);
  }

  async function transitionMultiPhase(phase, data = null) {
    state.phase = phase;
    state.phaseData = data;
    const payload = data ? GD.deepClone(data) : null;
    if (payload) {
      // alive map と history を同期
      payload.day = state.day;
      payload.alive = {};
      for (const p of state.players) payload.alive[p.uid] = p.alive;
      payload.history = state.history;
    } else {
      const aliveMap = {};
      for (const p of state.players) aliveMap[p.uid] = p.alive;
      data = { day: state.day, alive: aliveMap, history: state.history };
    }
    await FB.setPhase(phase, payload || data);
    emit('onPhaseChange', phase, payload || data);
  }

  async function setPhase(phase, data = null) {
    if (state.mode === 'multi' && state.isHost) {
      await transitionMultiPhase(phase, data);
    } else {
      await transitionLocalPhase(phase, data);
    }
  }

  /* ============================================================
     人間ゲームメソッド: 「準備完了」を押した
     ============================================================ */
  async function markReady(phaseKey) {
    if (state.mode === 'multi') {
      try { await FB.setReady(phaseKey, true); } catch(e) { console.warn(e); }
    } else {
      state._localReady = state._localReady || {};
      state._localReady[phaseKey] = true;
    }
  }

  function waitLocalReady(phaseKey) {
    return new Promise((resolve) => {
      const check = () => {
        if (state._localReady && state._localReady[phaseKey]) {
          state._localReady[phaseKey] = false;
          resolve();
        } else {
          setTimeout(check, 150);
        }
      };
      check();
    });
  }

  /* ============================================================
     人間プレイヤー全員の Ready を待つ (host のみ)
     ============================================================ */
  async function waitAllHumansReady(phaseKey, opts = {}) {
    if (state.mode !== 'multi' || !state.isHost) return { timeout: false };
    const aliveHumans = humanPlayers().filter(p => p.alive).map(p => p.uid);
    if (aliveHumans.length === 0) return { timeout: false };
    try { await FB.clearReady(phaseKey); } catch(_) {}
    const result = await FB.waitAllReady(phaseKey, aliveHumans, {
      timeoutMs: opts.timeoutMs || 0,
      onProgress: (uids) => emit('onWaitProgress', phaseKey, uids, aliveHumans)
    });
    return result;
  }

  /* ============================================================
     ★★ メインループ (host) ★★
     キャラ画面 → 役職確認 → Day1夜 → 朝 → 議論 → 投票 → 処刑 → 次の夜...
     ============================================================ */
  async function runMainLoopAsHost() {
    try {
      // 1. キャラ表示
      await setPhase(PHASES.CHARACTERS, { day: 0 });
      if (state.mode === 'multi') {
        // ローディングは出さない。画面上の ready-status に任せる。
        await waitAllHumansReady('characters');
      } else {
        await waitLocalReady('characters');
      }

      // 2. 役職確認
      await setPhase(PHASES.ROLE, { day: 0 });
      // ホスト自身の role はすでに state にある。Hooks 経由で UI に流す
      const me = self();
      if (me) emit('onRoleAssigned', me.role, buildHumanRoleInfo(me.uid));
      if (state.mode === 'multi') {
        await waitAllHumansReady('role');
      } else {
        await waitLocalReady('role');
      }

      // 3. Day ループ
      state.day = 1;
      while (true) {
        await runNightPhase();
        const winNight = checkWinner();
        if (winNight) { await endGame(winNight); return; }

        await runMorningPhase();

        await runDiscussionPhase();

        await runVotePhase();

        await runExecutionPhase();
        const winDay = checkWinner();
        if (winDay) { await endGame(winDay); return; }

        if (state.day >= CONFIG.MAX_DAY) {
          await endGame({ winner: 'werewolf', reason: `${CONFIG.MAX_DAY}日経過: 人狼陣営の勝利` });
          return;
        }
        state.day += 1;
      }
    } catch (e) {
      reportError(e, { where: 'main-loop' });
    }
  }

  /* ============================================================
     夜フェーズ
     ============================================================ */
  async function runNightPhase() {
    await setPhase(PHASES.NIGHT, { day: state.day });
    state.nightActions = {};

    // 人間プレイヤー: 自分の役職に応じてアクションを送信、他はそのまま完了
    // AI: 内部で決定
    // ホストはAIの全アクションを実行 + 結果を計算する

    // ▼ AIのアクション
    const aiActions = {};
    const ais = aiPlayers().filter(p => p.alive);
    const tasks = [];

    for (const ai of ais) {
      tasks.push((async () => {
        const ctx = buildCtx(ai);
        try {
          if (ai.role === 'werewolf') {
            const res = await AI.decideAttackTarget(ctx);
            if (res) {
              aiActions[ai.uid] = { type: 'attack', targetUid: res.targetUid, targetName: res.targetName };
              recordThought(ai.uid, state.day, 'attack', res.thought);
            }
          } else if (ai.role === 'seer') {
            const res = await AI.decideFortuneTarget(ctx);
            if (res) {
              aiActions[ai.uid] = { type: 'fortune', targetUid: res.targetUid, targetName: res.targetName };
              recordThought(ai.uid, state.day, 'fortune', res.thought);
            }
          } else if (ai.role === 'knight') {
            const res = await AI.decideGuardTarget(ctx);
            if (res) {
              aiActions[ai.uid] = { type: 'guard', targetUid: res.targetUid, targetName: res.targetName };
              recordThought(ai.uid, state.day, 'guard', res.thought);
            }
          } else {
            // medium / villager: nothing at night
          }
        } catch (err) {
          console.warn('AI night action error', ai.displayName, err);
          // フォールバック: ランダム
          if (ai.role === 'werewolf') {
            const teammateUids = state.players.filter(p => p.role === 'werewolf').map(p => p.uid);
            const cands = state.players.filter(p => p.alive && !teammateUids.includes(p.uid));
            if (cands.length) {
              const t = GD.pickRandom(cands);
              aiActions[ai.uid] = { type: 'attack', targetUid: t.uid, targetName: t.displayName };
            }
          } else if (ai.role === 'seer' || ai.role === 'knight') {
            const cands = aliveExcept(ai.uid);
            if (cands.length) {
              const t = GD.pickRandom(cands);
              aiActions[ai.uid] = { type: ai.role === 'seer' ? 'fortune' : 'guard', targetUid: t.uid, targetName: t.displayName };
            }
          }
        }
      })());
    }

    // ▼ 人間プレイヤーのアクション待ち
    const humanActionPromise = waitForHumanNightActions();

    await Promise.all([Promise.all(tasks), humanActionPromise]);

    // 全アクション収集 → 解決
    const allActions = { ...aiActions };
    Object.assign(allActions, state.nightActions);

    // 占い結果を seer 自身(人間 or AI)にフィードバック
    for (const [uid, act] of Object.entries(allActions)) {
      if (act.type === 'fortune' && act.targetUid) {
        const targetP = findByUid(act.targetUid);
        if (targetP) {
          const isWolf = (targetP.role === 'werewolf');
          ensureHistoryDay();
          const hist = state.history.find(h => h.day === state.day);
          hist.fortuneResultsBy = hist.fortuneResultsBy || {};
          hist.fortuneResultsBy[uid] = {
            day: state.day,
            targetUid: targetP.uid,
            targetName: targetP.displayName,
            isWerewolf: isWolf
          };
          // AI brain にも追加
          if (state.aiBrains[uid]) {
            const fr = state.aiBrains[uid].roleInfo.fortuneResults || [];
            fr.push({ day: state.day, targetName: targetP.displayName, isWerewolf: isWolf });
            state.aiBrains[uid].roleInfo.fortuneResults = fr;
          }
        }
      }
    }

    // 襲撃判定 (人狼の attack を集計、最多をターゲット)
    const attackVotes = {};
    for (const [uid, act] of Object.entries(allActions)) {
      if (act.type === 'attack' && act.targetUid) {
        attackVotes[act.targetUid] = (attackVotes[act.targetUid] || 0) + 1;
      }
    }
    let attackTargetUid = null;
    let maxV = 0;
    for (const [uid, v] of Object.entries(attackVotes)) {
      if (v > maxV) { maxV = v; attackTargetUid = uid; }
    }

    // 騎士護衛
    const guardedUids = new Set();
    for (const [uid, act] of Object.entries(allActions)) {
      if (act.type === 'guard' && act.targetUid) guardedUids.add(act.targetUid);
    }

    ensureHistoryDay();
    const hist = state.history.find(h => h.day === state.day);
    if (state.day === 1) {
      // Day1 朝は襲撃なし
      hist.attackedUid = null;
      hist.attackedName = null;
      hist.peace = false;
    } else if (attackTargetUid && !guardedUids.has(attackTargetUid)) {
      const victim = findByUid(attackTargetUid);
      if (victim) {
        victim.alive = false;
        hist.attackedUid = victim.uid;
        hist.attackedName = victim.displayName;
        hist.peace = false;
      }
    } else {
      hist.attackedUid = null;
      hist.attackedName = null;
      hist.peace = true;
    }

    emit('onPlayersUpdate', state.players);
    emit('onHistoryUpdate', state.history);
  }

  function ensureHistoryDay() {
    let hist = state.history.find(h => h.day === state.day);
    if (!hist) {
      hist = {
        day: state.day,
        attackedUid: null,
        attackedName: null,
        morningSpeeches: [],
        votes: [],
        executedUid: null,
        executedName: null,
        executedRole: null,
        peace: false,
        fortuneResultsBy: {}
      };
      state.history.push(hist);
    }
    return hist;
  }

  /* ============================================================
     人間プレイヤーの夜アクション待ち
     ソロ: 直接 submitNightAction が呼ばれる
     マルチ: Firebase経由で集める
     ============================================================ */
  function waitForHumanNightActions() {
    return new Promise(async (resolve) => {
      const livingHumans = humanPlayers().filter(p => p.alive);
      const needed = livingHumans.filter(p => ['werewolf', 'seer', 'knight'].includes(p.role));
      if (needed.length === 0) { resolve(); return; }

      if (state.mode === 'solo') {
        // ソロ: nightActions に self の uid のキーが入るのを待つ
        const me = self();
        if (!me || !needed.includes(me)) { resolve(); return; }
        const interval = setInterval(() => {
          if (state.nightActions[me.uid]) {
            clearInterval(interval);
            resolve();
          }
        }, 200);
      } else {
        // マルチ: nightActions を Firebase から listen
        try {
          let resolved = false;
          const F = window.__FB;
          const ref = F.ref(F.db, `rooms/${FB.roomId}/nightActions/day${state.day}`);
          const handler = (snap) => {
            const data = snap.val() || {};
            // needed の全人間が送信完了？
            const allOk = needed.every(p => data[p.uid]);
            if (allOk && !resolved) {
              resolved = true;
              for (const [uid, act] of Object.entries(data)) {
                state.nightActions[uid] = act;
              }
              try { F.off(ref, 'value', handler); } catch(_) {}
              resolve();
            }
          };
          F.onValue(ref, handler);
          // タイムアウトなしでは進まないことがあるので 90s で打ち切り → ランダム補完
          setTimeout(() => {
            if (resolved) return;
            resolved = true;
            try { F.off(ref, 'value', handler); } catch(_) {}
            for (const p of needed) {
              if (state.nightActions[p.uid]) continue;
              const cands = aliveExcept(p.uid);
              if (cands.length) {
                const t = GD.pickRandom(cands);
                const type = p.role === 'werewolf' ? 'attack' : (p.role === 'seer' ? 'fortune' : 'guard');
                state.nightActions[p.uid] = { type, targetUid: t.uid, targetName: t.displayName };
              }
            }
            resolve();
          }, 90000);
        } catch (e) {
          console.warn('night actions listener error', e);
          resolve();
        }
      }
    });
  }

  /* ============================================================
     人間プレイヤーが夜アクションを送信 (UI から呼ばれる)
     ============================================================ */
  async function submitNightAction(action) {
    const me = self();
    if (!me) return;
    state.nightActions[me.uid] = action;
    if (state.mode === 'multi') {
      try { await FB.submitNightAction(state.day, action); } catch(e) { console.warn(e); }
    }
  }

  /* ============================================================
     朝フェーズ
     ============================================================ */
  async function runMorningPhase() {
    await setPhase(PHASES.MORNING, { day: state.day });

    const hist = state.history.find(h => h.day === state.day);
    const morningSpeeches = hist.morningSpeeches = [];

    // 生存者の発言 (人間は発言しない、AIのみ)
    const livingAis = aiPlayers().filter(p => p.alive);
    for (const ai of livingAis) {
      const ctx = buildCtx(ai);
      try {
        await GD.sleep(CONFIG.MORNING_SPEECH_DELAY_MS);
        const res = await AI.generateMorningSpeech(ctx);
        const entry = {
          uid: ai.uid,
          name: ai.displayName,
          speech: res.speech,
          thought: res.thought,
          isHuman: false
        };
        morningSpeeches.push(entry);
        recordThought(ai.uid, state.day, 'morning', res.thought);
        emit('onSpeechAdded', entry);
        emit('onHistoryUpdate', state.history);
        if (state.mode === 'multi' && state.isHost) {
          await transitionMultiPhase(PHASES.MORNING, { day: state.day });
        }
      } catch (err) {
        console.warn('morning speech error', ai.displayName, err);
        const entry = {
          uid: ai.uid,
          name: ai.displayName,
          speech: '...(声が出ない)',
          thought: '',
          error: true
        };
        morningSpeeches.push(entry);
        emit('onSpeechAdded', entry);
      }
    }

    // 朝の表示完了 → 議論ボタン待ち
    if (state.mode === 'multi') {
      // ローディングは出さない (画面の ready-status に任せる)
      await waitAllHumansReady('morning_d' + state.day);
    } else {
      await waitLocalReady('morning_d' + state.day);
    }
  }

  /* ============================================================
     議論フェーズ
     ============================================================ */
  async function runDiscussionPhase() {
    await setPhase(PHASES.DISCUSSION, { day: state.day });

    const me = self();
    const isAlive = me ? me.alive : false;
    const totalSec = isAlive ? CONFIG.DISCUSSION_TIME_SEC : CONFIG.DISCUSSION_TIME_DEAD_SEC;
    state.discussionEndsAt = Date.now() + totalSec * 1000;

    if (state.discussionTimerId) clearInterval(state.discussionTimerId);

    return new Promise((resolve) => {
      let earlyEnd = false;
      const tick = () => {
        const left = Math.max(0, Math.round((state.discussionEndsAt - Date.now()) / 1000));
        emit('onTimerTick', left);
        if (left <= 0 || earlyEnd) {
          clearInterval(state.discussionTimerId);
          state.discussionTimerId = null;
          resolve();
        }
      };
      state.discussionTimerId = setInterval(tick, 250);
      tick();

      // 人間が「議論を終えて投票へ」ボタンを押すまでの判定
      // 全人間Readyで早期終了
      if (state.mode === 'multi') {
        (async () => {
          try {
            await FB.clearReady('discussion_d' + state.day);
          } catch(_) {}
          await waitAllHumansReady('discussion_d' + state.day, { timeoutMs: totalSec * 1000 });
          earlyEnd = true;
        })();
      } else {
        // ソロ: 自分の Ready フラグを監視
        const checkLocal = () => {
          if (state._discussionReadyLocal) {
            earlyEnd = true;
          } else {
            setTimeout(checkLocal, 200);
          }
        };
        state._discussionReadyLocal = false;
        checkLocal();
      }
    });
  }

  function endDiscussionEarlyLocal() {
    state._discussionReadyLocal = true;
  }

  /* ============================================================
     伝言送信 (人間 → AI)
     ============================================================ */
  async function sendMessageToAi(targetUid, text) {
    text = String(text || '').slice(0, CONFIG.MESSAGE_MAX_LENGTH).trim();
    if (!text) throw new Error('EMPTY_MESSAGE');
    const me = self();
    if (!me || !me.alive) throw new Error('CANT_SEND');
    const target = findByUid(targetUid);
    if (!target || target.kind !== 'ai') throw new Error('INVALID_TARGET');

    if (!state.messagesByDay[state.day]) state.messagesByDay[state.day] = [];
    const msg = {
      fromUid: me.uid,
      fromName: me.displayName,
      targetUid,
      text,
      at: Date.now()
    };
    state.messagesByDay[state.day].push(msg);

    if (state.mode === 'multi') {
      try { await FB.submitMessage(state.day, targetUid, text); } catch(e) { console.warn(e); }
    }
    return msg;
  }

  /* ============================================================
     投票フェーズ
     ============================================================ */
  async function runVotePhase() {
    await setPhase(PHASES.VOTE, { day: state.day });
    state.voteSelections = {};

    const livingAis = aiPlayers().filter(p => p.alive);
    const livingHumans = humanPlayers().filter(p => p.alive);

    const aiVotes = {};
    const aiTasks = [];
    for (const ai of livingAis) {
      aiTasks.push((async () => {
        const ctx = buildCtx(ai);
        try {
          const res = await AI.decideVote(ctx);
          if (res && res.targetUid) {
            aiVotes[ai.uid] = res.targetUid;
            recordThought(ai.uid, state.day, 'vote', res.thought);
          } else {
            // フォールバック
            const cands = aliveExcept(ai.uid);
            if (cands.length) aiVotes[ai.uid] = GD.pickRandom(cands).uid;
          }
        } catch (e) {
          console.warn('AI vote error', ai.displayName, e);
          const cands = aliveExcept(ai.uid);
          if (cands.length) aiVotes[ai.uid] = GD.pickRandom(cands).uid;
        }
      })());
    }

    const humanVotePromise = waitForHumanVotes(livingHumans);

    await Promise.all([Promise.all(aiTasks), humanVotePromise]);

    const allVotes = { ...aiVotes };
    Object.assign(allVotes, state.voteSelections);

    // 結果を history に
    const hist = ensureHistoryDay();
    const voteEntries = [];
    for (const [fromUid, toUid] of Object.entries(allVotes)) {
      const fromP = findByUid(fromUid);
      const toP = (toUid && toUid !== '__none__') ? findByUid(toUid) : null;
      voteEntries.push({
        fromUid, fromName: fromP ? fromP.displayName : '不明',
        toUid: toP ? toP.uid : null, toName: toP ? toP.displayName : '無投票'
      });
    }
    hist.votes = voteEntries;

    emit('onHistoryUpdate', state.history);
  }

  function waitForHumanVotes(livingHumans) {
    return new Promise(async (resolve) => {
      if (livingHumans.length === 0) { resolve(); return; }

      if (state.mode === 'solo') {
        const me = self();
        if (!me || !me.alive) { resolve(); return; }
        const interval = setInterval(() => {
          if (state.voteSelections[me.uid]) {
            clearInterval(interval);
            resolve();
          }
        }, 200);
      } else {
        try {
          await FB.clearReady('vote_d' + state.day);
        } catch(_) {}
        const livingUids = livingHumans.map(p => p.uid);
        const F = window.__FB;
        const ref = F.ref(F.db, `rooms/${FB.roomId}/votes/day${state.day}`);
        let resolved = false;
        const handler = (snap) => {
          const data = snap.val() || {};
          if (livingUids.every(u => data[u])) {
            if (resolved) return;
            resolved = true;
            for (const [uid, t] of Object.entries(data)) {
              state.voteSelections[uid] = t === '__none__' ? null : t;
            }
            try { F.off(ref, 'value', handler); } catch(_) {}
            resolve();
          }
        };
        F.onValue(ref, handler);
        setTimeout(() => {
          if (resolved) return;
          resolved = true;
          for (const p of livingHumans) {
            if (state.voteSelections[p.uid]) continue;
            const cands = aliveExcept(p.uid);
            if (cands.length) state.voteSelections[p.uid] = GD.pickRandom(cands).uid;
          }
          try { F.off(ref, 'value', handler); } catch(_) {}
          resolve();
        }, CONFIG.VOTE_TIMEOUT_MS);
      }
    });
  }

  async function submitHumanVote(targetUid) {
    const me = self();
    if (!me || !me.alive) return;
    state.voteSelections[me.uid] = targetUid;
    if (state.mode === 'multi') {
      try { await FB.submitVote(state.day, targetUid); } catch(e) { console.warn(e); }
    }
  }

  /* ============================================================
     処刑フェーズ
     ============================================================ */
  async function runExecutionPhase() {
    const hist = ensureHistoryDay();

    // 投票集計
    const counts = {};
    for (const v of hist.votes || []) {
      if (!v.toUid) continue;
      counts[v.toUid] = (counts[v.toUid] || 0) + 1;
    }
    let topUid = null, topCount = 0;
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (sorted.length) {
      topCount = sorted[0][1];
      const tied = sorted.filter(([, c]) => c === topCount).map(([u]) => u);
      topUid = GD.pickRandom(tied);
    }

    let executedP = topUid ? findByUid(topUid) : null;
    if (executedP) {
      executedP.alive = false;
      hist.executedUid = executedP.uid;
      hist.executedName = executedP.displayName;
      hist.executedRole = executedP.role;
    } else {
      hist.executedUid = null;
      hist.executedName = null;
      hist.executedRole = null;
    }

    // 霊媒師に結果を渡す (history 経由で次回参照)
    // (collectMediumHistory が history から拾う)

    await setPhase(PHASES.EXECUTION, {
      day: state.day,
      voteCounts: counts,
      executedUid: executedP ? executedP.uid : null,
      executedName: executedP ? executedP.displayName : null,
      executedRole: executedP ? executedP.role : null,
      votes: hist.votes
    });

    emit('onHistoryUpdate', state.history);
    emit('onPlayersUpdate', state.players);

    await GD.sleep(CONFIG.EXECUTION_WAIT_MS);
  }

  /* ============================================================
     ゲーム終了
     ============================================================ */
  async function endGame(result) {
    state.result = result;
    if (state.mode === 'multi' && state.isHost) {
      try {
        const rolesReveal = {};
        for (const p of state.players) rolesReveal[p.uid] = p.role;
        await FB.setResult(result);
        await transitionMultiPhase(PHASES.RESULT, { day: state.day, rolesReveal });
        await FB.setMetaStatus('ended');
      } catch (e) { console.warn(e); }
    } else if (state.mode === 'solo') {
      await transitionLocalPhase(PHASES.RESULT, { day: state.day });
    }
    emit('onResult', result);
  }

  /* ============================================================
     ゲスト側: 自分の夜アクション送信 / 投票送信 (multi)
     ============================================================ */
  async function guestSubmitNightAction(action) {
    if (state.mode !== 'multi') return;
    try { await FB.submitNightAction(state.day, action); } catch(e) { console.warn(e); }
  }
  async function guestSubmitVote(targetUid) {
    if (state.mode !== 'multi') return;
    try { await FB.submitVote(state.day, targetUid); } catch(e) { console.warn(e); }
  }
  async function guestSendMessage(targetUid, text) {
    if (state.mode !== 'multi') return;
    try { await FB.submitMessage(state.day, targetUid, text); } catch(e) { console.warn(e); }
  }

  /* ============================================================
     thought log のエクスポート
     ============================================================ */
  function getThoughtLog() {
    const out = [];
    for (const ai of aiPlayers()) {
      const list = state.thoughts[ai.uid] || [];
      const days = {};
      for (const t of list) {
        if (!days[t.day]) days[t.day] = [];
        days[t.day].push({ kind: t.kind, text: t.text });
      }
      out.push({
        uid: ai.uid,
        name: ai.displayName,
        role: ai.role,
        days
      });
    }
    return out;
  }

  /* ============================================================
     公開API
     ============================================================ */
  window.Game = {
    state,
    setHooks,
    reset,
    self, alive, aliveExcept, aiPlayers, humanPlayers, findByUid, findByDisplayName,
    // start
    startSolo,
    startMultiAsHost,
    joinAsGuest,
    runMainLoopAsHost,
    // human actions
    submitNightAction,
    submitHumanVote,
    sendMessageToAi,
    endDiscussionEarlyLocal,
    markReady,
    // misc
    buildHumanRoleInfo,
    getThoughtLog,
    checkWinner
  };
})();
