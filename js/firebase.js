/* ============================================================
   js/firebase.js
   Firebase 操作 (ルーム管理 / Ready 同期 / データ読み書き)
   マルチプレイ専用。ソロでは呼び出されない。
   ============================================================ */
'use strict';

(function() {
  const GD = window.GameData;
  const { CONFIG } = GD;

  const state = {
    authReady: false,
    uid: null,
    roomId: null,
    isHost: false,
    listeners: []
  };

  function fb() {
    if (!window.__FB) throw new Error('ERR_FIREBASE_NOT_READY');
    return window.__FB;
  }

  function waitForFirebase() {
    return new Promise(resolve => {
      if (window.__FB) return resolve();
      window.addEventListener('firebase-ready', () => resolve(), { once: true });
    });
  }

  async function initAuth() {
    await waitForFirebase();
    if (state.authReady && state.uid) return state.uid;
    const F = fb();
    return new Promise((resolve, reject) => {
      let resolved = false;
      const unsub = F.onAuthStateChanged(F.auth, (user) => {
        if (user && !resolved) {
          resolved = true;
          state.uid = user.uid;
          state.authReady = true;
          try { unsub(); } catch(_) {}
          resolve(user.uid);
        }
      });
      F.signInAnonymously(F.auth).catch(err => {
        if (!resolved) {
          resolved = true;
          reject(new Error('ERR_AUTH_FAILED: ' + (err?.message || err)));
        }
      });
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('ERR_AUTH_TIMEOUT'));
        }
      }, 10000);
    });
  }

  function assertInRoom() {
    if (!state.roomId) throw new Error('NOT_IN_ROOM');
    if (!state.uid) throw new Error('NOT_AUTHENTICATED');
  }

  function attach(path, cb) {
    const F = fb();
    const r = F.ref(F.db, path);
    const handler = (snap) => {
      try { cb(snap.val()); } catch(e) { console.error('listener error', path, e); }
    };
    F.onValue(r, handler);
    const entry = { ref: r, handler, path };
    state.listeners.push(entry);
    return () => {
      try { F.off(r, 'value', handler); } catch(_) {}
      state.listeners = state.listeners.filter(l => l !== entry);
    };
  }

  function detachAll() {
    const F = fb();
    for (const l of state.listeners) {
      try { F.off(l.ref, 'value', l.handler); } catch(_) {}
    }
    state.listeners = [];
  }

  /* ===== Room ===== */
  async function createRoom(playerName) {
    await initAuth();
    const F = fb();
    let roomId = '';
    for (let i = 0; i < 12; i++) {
      roomId = GD.generateRoomId();
      const snap = await F.get(F.ref(F.db, `rooms/${roomId}/meta`));
      if (!snap.exists()) break;
    }
    state.roomId = roomId;
    state.isHost = true;

    await F.set(F.ref(F.db, `rooms/${roomId}/meta`), {
      hostUid: state.uid,
      status: 'lobby',
      createdAt: F.serverTimestamp()
    });
    await F.set(F.ref(F.db, `rooms/${roomId}/players/${state.uid}`), {
      name: playerName,
      isHost: true,
      joinedAt: Date.now()
    });
    F.onDisconnect(F.ref(F.db, `rooms/${roomId}/players/${state.uid}`)).remove();
    return roomId;
  }

  async function joinRoom(roomId, playerName) {
    await initAuth();
    const F = fb();
    const metaSnap = await F.get(F.ref(F.db, `rooms/${roomId}/meta`));
    if (!metaSnap.exists()) throw new Error('ROOM_NOT_FOUND');
    const meta = metaSnap.val();
    if (meta.status !== 'lobby') throw new Error('ROOM_IN_PROGRESS');
    const playersSnap = await F.get(F.ref(F.db, `rooms/${roomId}/players`));
    const players = playersSnap.val() || {};
    const count = Object.keys(players).length;
    if (count >= CONFIG.TOTAL_PLAYERS) throw new Error('ROOM_FULL');
    if (players[state.uid]) throw new Error('ALREADY_JOINED');

    state.roomId = roomId;
    state.isHost = false;

    await F.set(F.ref(F.db, `rooms/${roomId}/players/${state.uid}`), {
      name: playerName,
      isHost: false,
      joinedAt: Date.now()
    });
    F.onDisconnect(F.ref(F.db, `rooms/${roomId}/players/${state.uid}`)).remove();
    return roomId;
  }

  async function leaveRoom() {
    if (!state.roomId || !state.uid) return;
    const F = fb();
    const rid = state.roomId;
    const wasHost = state.isHost;
    detachAll();
    try {
      await F.remove(F.ref(F.db, `rooms/${rid}/players/${state.uid}`));
    } catch(_) {}
    if (wasHost) {
      // Host leaves → room is done. Best-effort cleanup.
      try { await F.remove(F.ref(F.db, `rooms/${rid}`)); } catch(_) {}
    }
    state.roomId = null;
    state.isHost = false;
  }

  /* ===== Listeners ===== */
  function listenPlayers(cb) {
    assertInRoom();
    return attach(`rooms/${state.roomId}/players`, (val) => {
      const list = [];
      if (val) {
        for (const [uid, data] of Object.entries(val)) {
          list.push({ uid, ...data });
        }
        list.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
      }
      cb(list);
    });
  }

  function listenMeta(cb) {
    assertInRoom();
    return attach(`rooms/${state.roomId}/meta`, cb);
  }

  function listenGame(cb) {
    assertInRoom();
    return attach(`rooms/${state.roomId}/game`, (val) => cb(val || null));
  }

  function listenMyRole(cb) {
    assertInRoom();
    return attach(`rooms/${state.roomId}/roles/${state.uid}`, cb);
  }

  function listenReady(phaseKey, cb) {
    assertInRoom();
    return attach(`rooms/${state.roomId}/ready/${phaseKey}`, (val) => {
      cb(val ? Object.keys(val) : []);
    });
  }

  /* ===== Host writes ===== */
  async function setMetaStatus(status) {
    assertInRoom();
    const F = fb();
    await F.update(F.ref(F.db, `rooms/${state.roomId}/meta`), { status });
  }

  async function setPhase(phase, data = null) {
    assertInRoom();
    const F = fb();
    const snap = await F.get(F.ref(F.db, `rooms/${state.roomId}/game/phaseVersion`));
    const version = (snap.val() || 0) + 1;
    const payload = { phase, phaseVersion: version };
    if (data !== null) payload.phaseData = data;
    else payload.phaseData = null;
    await F.update(F.ref(F.db, `rooms/${state.roomId}/game`), payload);
  }

  async function setResult(resultObj) {
    assertInRoom();
    const F = fb();
    await F.update(F.ref(F.db, `rooms/${state.roomId}/game`), { result: resultObj });
  }

  async function setAllRoles(rolesByUid) {
    assertInRoom();
    const F = fb();
    await F.set(F.ref(F.db, `rooms/${state.roomId}/roles`), rolesByUid);
  }

  async function getAllRoles() {
    assertInRoom();
    const F = fb();
    const snap = await F.get(F.ref(F.db, `rooms/${state.roomId}/roles`));
    return snap.val() || {};
  }

  async function getMeta() {
    assertInRoom();
    const F = fb();
    const snap = await F.get(F.ref(F.db, `rooms/${state.roomId}/meta`));
    return snap.val() || null;
  }

  async function getPlayersOnce() {
    assertInRoom();
    const F = fb();
    const snap = await F.get(F.ref(F.db, `rooms/${state.roomId}/players`));
    const val = snap.val() || {};
    const list = [];
    for (const [uid, data] of Object.entries(val)) list.push({ uid, ...data });
    list.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    return list;
  }

  /* ===== Ready sync ===== */
  async function setReady(phaseKey, value = true) {
    assertInRoom();
    const F = fb();
    const r = F.ref(F.db, `rooms/${state.roomId}/ready/${phaseKey}/${state.uid}`);
    if (value) await F.set(r, Date.now());
    else await F.remove(r);
  }

  async function clearReady(phaseKey) {
    assertInRoom();
    const F = fb();
    await F.remove(F.ref(F.db, `rooms/${state.roomId}/ready/${phaseKey}`));
  }

  function waitAllReady(phaseKey, expectedUids, opts = {}) {
    assertInRoom();
    const { timeoutMs = 0, onProgress = null } = opts;
    return new Promise((resolve) => {
      let settled = false;
      let unsub = null;
      let timer = null;
      const finish = (timeout) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (unsub) unsub();
        resolve({ timeout });
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => finish(true), timeoutMs);
      }
      if (expectedUids.length === 0) { finish(false); return; }
      unsub = listenReady(phaseKey, (readyUids) => {
        if (onProgress) try { onProgress(readyUids); } catch(_) {}
        const allReady = expectedUids.every(uid => readyUids.includes(uid));
        if (allReady) finish(false);
      });
    });
  }

  /* ===== Votes ===== */
  async function submitVote(day, targetUid) {
    assertInRoom();
    const F = fb();
    await F.set(F.ref(F.db, `rooms/${state.roomId}/votes/day${day}/${state.uid}`), targetUid || '__none__');
  }

  async function getAllVotes(day) {
    assertInRoom();
    const F = fb();
    const snap = await F.get(F.ref(F.db, `rooms/${state.roomId}/votes/day${day}`));
    return snap.val() || {};
  }

  function waitVotes(day, expectedUids, timeoutMs) {
    assertInRoom();
    return new Promise((resolve) => {
      let settled = false;
      let unsub = null;
      let timer = null;
      const finish = (votes, timeout) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (unsub) unsub();
        resolve({ votes, timeout });
      };
      if (timeoutMs > 0) {
        timer = setTimeout(async () => {
          const current = await getAllVotes(day);
          finish(current, true);
        }, timeoutMs);
      }
      if (expectedUids.length === 0) { finish({}, false); return; }
      unsub = attach(`rooms/${state.roomId}/votes/day${day}`, (val) => {
        const votes = val || {};
        if (expectedUids.every(u => votes[u])) finish(votes, false);
      });
    });
  }

  /* ===== Messages (secret messages to AI) ===== */
  async function submitMessage(day, targetAiUid, text) {
    assertInRoom();
    const F = fb();
    const listRef = F.ref(F.db, `rooms/${state.roomId}/messages/day${day}/${state.uid}`);
    const newRef = F.push(listRef);
    await F.set(newRef, { targetUid: targetAiUid, text, at: Date.now() });
  }

  async function getAllMessages(day) {
    assertInRoom();
    const F = fb();
    const snap = await F.get(F.ref(F.db, `rooms/${state.roomId}/messages/day${day}`));
    const out = [];
    if (snap.exists()) {
      const data = snap.val() || {};
      for (const [fromUid, msgs] of Object.entries(data)) {
        for (const [id, m] of Object.entries(msgs || {})) {
          out.push({ fromUid, id, ...m });
        }
      }
    }
    return out;
  }

  /* ===== Day History (host writes; everyone reads) =====
     Path: rooms/{roomId}/history/day{N}/
       nightResults: { attackedUid, attackedName, peace }
       morningSpeeches/{pushId}: { uid, name, speech, thought, error?, at }
       fortuneResults/{seerUid}: { targetUid, targetName, result, at }
       votes/{voterUid}: { fromUid, fromName, toUid, toName }
       execution: { executedUid, executedName, executedRole }
  ============================================================ */
  async function setDayNightResults(day, data) {
    assertInRoom();
    const F = fb();
    await F.set(F.ref(F.db, `rooms/${state.roomId}/history/day${day}/nightResults`), data);
  }

  async function pushDayMorningSpeech(day, entry) {
    assertInRoom();
    const F = fb();
    const listRef = F.ref(F.db, `rooms/${state.roomId}/history/day${day}/morningSpeeches`);
    const newRef = F.push(listRef);
    await F.set(newRef, { ...entry, at: Date.now() });
  }

  async function setDayFortune(day, seerUid, data) {
    assertInRoom();
    const F = fb();
    await F.set(F.ref(F.db, `rooms/${state.roomId}/history/day${day}/fortuneResults/${seerUid}`), { ...data, at: Date.now() });
  }

  async function setDayVotes(day, votesByVoter) {
    assertInRoom();
    const F = fb();
    await F.set(F.ref(F.db, `rooms/${state.roomId}/history/day${day}/votes`), votesByVoter);
  }

  async function setDayExecution(day, data) {
    assertInRoom();
    const F = fb();
    await F.set(F.ref(F.db, `rooms/${state.roomId}/history/day${day}/execution`), data);
  }

  function listenDayHistory(day, cb) {
    assertInRoom();
    return attach(`rooms/${state.roomId}/history/day${day}`, (val) => cb(val || null));
  }

  async function clearDayHistory(day) {
    assertInRoom();
    const F = fb();
    await F.set(F.ref(F.db, `rooms/${state.roomId}/history/day${day}`), null);
  }

  /* ===== Night Actions ===== */
  async function submitNightAction(day, action) {
    assertInRoom();
    const F = fb();
    await F.set(F.ref(F.db, `rooms/${state.roomId}/nightActions/day${day}/${state.uid}`), action);
  }

  async function getAllNightActions(day) {
    assertInRoom();
    const F = fb();
    const snap = await F.get(F.ref(F.db, `rooms/${state.roomId}/nightActions/day${day}`));
    return snap.val() || {};
  }

  /* ===== Reset ===== */
  function reset() {
    detachAll();
    state.roomId = null;
    state.isHost = false;
  }

  /* ===== Expose ===== */
  window.FirebaseAPI = {
    get uid() { return state.uid; },
    get roomId() { return state.roomId; },
    get isHost() { return state.isHost; },
    get authReady() { return state.authReady; },
    waitForFirebase,
    initAuth,
    createRoom, joinRoom, leaveRoom,
    listenPlayers, listenMeta, listenGame, listenMyRole, listenReady,
    setMetaStatus, setPhase, setResult,
    setAllRoles, getAllRoles, getMeta, getPlayersOnce,
    setReady, clearReady, waitAllReady,
    submitVote, getAllVotes, waitVotes,
    submitMessage, getAllMessages,
    setDayNightResults, pushDayMorningSpeech, setDayFortune, setDayVotes, setDayExecution,
    listenDayHistory, clearDayHistory,
    submitNightAction, getAllNightActions,
    detachAll, reset
  };
})();
