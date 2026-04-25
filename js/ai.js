/* ============================================================
   js/ai.js
   Gemini API 呼び出し / プロンプト / エラーハンドリング
   ============================================================ */
'use strict';

(function() {
  const GD = window.GameData;
  const { CONFIG, ROLES, TEAMS, REACTION_STYLES, FALLBACK_CHARACTERS } = GD;

  /* ===== API Key ===== */
  function getApiKey() {
    return localStorage.getItem(CONFIG.API_KEY_STORAGE) || '';
  }
  function setApiKey(key) {
    if (!key) localStorage.removeItem(CONFIG.API_KEY_STORAGE);
    else localStorage.setItem(CONFIG.API_KEY_STORAGE, key.trim());
  }
  function hasApiKey() { return !!getApiKey(); }

  /* ===== Core Gemini call =====
     仕様書 4.3 準拠:
       - エンドポイント: generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
       - URLパラメータ認証 ?key=API_KEY
       - responseMimeType: application/json
       - systemInstruction として送信
       - 最大4回リトライ (429/503)
       - 503 時 flash -> flash-lite にフォールバック
  */
  async function callGemini({
    systemPrompt, userPrompt,
    schema = null,
    temperature = 0.85,
    maxOutputTokens = 2048,
    apiKey = null
  }) {
    const key = apiKey || getApiKey();
    if (!key) throw new Error('ERR_NO_API_KEY');

    const models = [CONFIG.GEMINI_MODEL_PRIMARY, CONFIG.GEMINI_MODEL_FALLBACK];
    let lastError = null;

    for (let mi = 0; mi < models.length; mi++) {
      const modelName = models[mi];
      let modelFatal = false;

      for (let attempt = 0; attempt < CONFIG.GEMINI_MAX_RETRIES; attempt++) {
        try {
          const body = {
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
              temperature,
              maxOutputTokens,
              responseMimeType: 'application/json',
              ...(schema ? { responseSchema: schema } : {})
            },
            safetySettings: [
              { category: 'HARM_CATEGORY_HARASSMENT',       threshold: 'BLOCK_ONLY_HIGH' },
              { category: 'HARM_CATEGORY_HATE_SPEECH',      threshold: 'BLOCK_ONLY_HIGH' },
              { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
              { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
            ]
          };

          const url = `${CONFIG.GEMINI_BASE_URL}/${modelName}:generateContent?key=${encodeURIComponent(key)}`;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });

          if (res.status === 401 || res.status === 403) {
            throw new Error('ERR_KEY_INVALID');
          }
          if (res.status === 429) {
            lastError = new Error('ERR_429');
            await GD.sleep(800 * Math.pow(2, attempt));
            continue;
          }
          if (res.status === 503) {
            lastError = new Error('ERR_503');
            await GD.sleep(500 * Math.pow(2, attempt));
            continue;
          }
          if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`ERR_${res.status}`);
          }

          const data = await res.json();
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (!text) throw new Error('ERR_EMPTY');

          try {
            return JSON.parse(text);
          } catch (_) {
            const m = text.match(/\{[\s\S]*\}/);
            if (m) {
              try { return JSON.parse(m[0]); } catch(__) {}
            }
            throw new Error('ERR_PARSE');
          }
        } catch (err) {
          lastError = err;
          const msg = err?.message || String(err);
          if (msg === 'ERR_NO_API_KEY' || msg === 'ERR_KEY_INVALID') {
            throw err;
          }
          if (msg === 'ERR_EMPTY' || msg === 'ERR_PARSE' || /ERR_4\d{2}/.test(msg)) {
            modelFatal = true;
            break;
          }
          // network / unknown: small backoff then retry
          await GD.sleep(400 * (attempt + 1));
        }
      }
      if (!modelFatal && lastError && /ERR_(429|503)/.test(lastError.message)) {
        // proceed to fallback model (503 fallback per spec)
      }
    }
    throw lastError || new Error('ERR_UNKNOWN');
  }

  /* ===== Response schemas ===== */
  const CHARACTER_SCHEMA = {
    type: 'object',
    properties: {
      characters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'string' },
            occupation: { type: 'string' },
            personality_tags: { type: 'array', items: { type: 'string' } },
            speech_style: { type: 'string' },
            catchphrase: { type: 'string' },
            background: { type: 'string' },
            lie_style: { type: 'string' },
            reasoning_style: { type: 'string' },
            message_reaction_style: { type: 'string' }
          },
          required: ['name','age','occupation','personality_tags','speech_style','catchphrase','background','lie_style','reasoning_style','message_reaction_style']
        }
      }
    },
    required: ['characters']
  };

  const SPEECH_SCHEMA = {
    type: 'object',
    properties: {
      speech: { type: 'string' },
      thought: { type: 'string' }
    },
    required: ['speech', 'thought']
  };

  const TARGET_SCHEMA = {
    type: 'object',
    properties: {
      target: { type: 'string' },
      thought: { type: 'string' }
    },
    required: ['target', 'thought']
  };

  /* ===== Character Generation ===== */
  function normalizeCharacter(c) {
    const validStyles = ['straightforward', 'skeptical', 'contrarian', 'logical', 'emotional'];
    let age = c.age;
    if (age === '不詳' || age === null || age === undefined || age === '') age = null;
    else age = String(age);
    return {
      name: String(c.name || '村人').slice(0, 5),
      age,
      occupation: String(c.occupation || '村人'),
      personality_tags: Array.isArray(c.personality_tags)
        ? c.personality_tags.slice(0, 3).map(String)
        : ['静か'],
      speech_style: String(c.speech_style || '私 / 丁寧'),
      catchphrase: String(c.catchphrase || '...'),
      background: String(c.background || ''),
      lie_style: String(c.lie_style || ''),
      reasoning_style: String(c.reasoning_style || ''),
      message_reaction_style: validStyles.includes(c.message_reaction_style) ? c.message_reaction_style : 'straightforward'
    };
  }

  async function generateCharacters(count) {
    if (count <= 0) return [];
    const systemPrompt = `あなたは人狼ゲーム用のキャラクター生成ツールです。
ダークファンタジー(ゴシック調)中世ヨーロッパ風の霧深い山村に住む ${count} 人の村人キャラクターを生成します。

【厳守ルール】
- ${count} 人全員が異なる性格・職業・年齢層・一人称であること
- name: カタカナ2〜5文字のファンタジー風の名前(日本語カタカナ)
- age: 数字の文字列(例 "22") または「不詳」
- occupation: 中世ヨーロッパ風の職業(雰囲気設定のみ。ゲーム中の推理根拠には絶対に使わない)
- personality_tags: 3つの性格を表すキーワードの配列(日本語)
- speech_style: 「一人称 / 口調の特徴」の形式(例「俺 / ぶっきらぼうで短い」)
- catchphrase: そのキャラが言いそうな口癖(1文、日本語)
- background: 1〜2文の背景(日本語)
- lie_style: 人狼役になった時の行動傾向(日本語)
- reasoning_style: 村人役の推理傾向(日本語)
- message_reaction_style: 次の5種のいずれか(英字):
   "straightforward" = 素直に信じる
   "skeptical"       = 疑い深く送り主自体を疑う
   "contrarian"      = 天邪鬼で逆方向に動く
   "logical"         = 論理性のみで評価
   "emotional"       = 口調の強さに流される
- ${count}人の中で5種のスタイルができるだけバランスよく分布するよう調整する
- 全フィールドは日本語(message_reaction_style のみ英字)
`;
    const userPrompt = `上記のルールに従い、${count} 人の多様なキャラクターを生成し、指定JSONで返してください。`;
    const res = await callGemini({
      systemPrompt, userPrompt,
      schema: CHARACTER_SCHEMA,
      temperature: 1.15,
      maxOutputTokens: 4096
    });
    const arr = Array.isArray(res?.characters) ? res.characters : [];
    return arr.slice(0, count).map(normalizeCharacter);
  }

  async function generateCharactersSafe(count, onFallback = null) {
    if (count <= 0) return [];
    try {
      const chars = await generateCharacters(count);
      if (chars.length >= count) return chars;
      const shortage = count - chars.length;
      const extras = GD.pickRandomN(FALLBACK_CHARACTERS, shortage).map(c => GD.deepClone(c));
      return chars.concat(extras);
    } catch (err) {
      if (onFallback) try { onFallback(err); } catch(_) {}
      return GD.pickRandomN(FALLBACK_CHARACTERS, count).map(c => GD.deepClone(c));
    }
  }

  function decideBluffStrategy(character) {
    const tags = character.personality_tags || [];
    const prob = GD.bluffProbability(tags);
    const willBluff = Math.random() < prob;
    if (!willBluff) return { willBluff: false, fakeRole: null };
    const fakeRole = Math.random() < 0.70 ? 'seer' : 'medium';
    return { willBluff: true, fakeRole };
  }

  /* ===== CO Detection (仕様書 4.9) ===== */
  const RX_SEER_CO = /(占い師|占いま?す|占い結果|占っ|占いC[O0]|僕.{0,4}占い|私.{0,4}占い|俺.{0,4}占い|わたし.{0,4}占い|わたくし.{0,4}占い|自分.{0,4}占い|うち.{0,4}占い|あっし.{0,4}占い)/;
  const RX_MEDIUM_CO = /(霊媒師|霊媒|霊視|霊能|霊媒結果|霊媒C[O0])/;
  function detectCOs(history) {
    const seer = new Map();   // name -> firstDay
    const medium = new Map();
    for (const d of (history || [])) {
      for (const sp of (d.morningSpeeches || [])) {
        if (RX_SEER_CO.test(sp.speech) && !seer.has(sp.name)) seer.set(sp.name, d.day);
        if (RX_MEDIUM_CO.test(sp.speech) && !medium.has(sp.name)) medium.set(sp.name, d.day);
      }
    }
    return {
      seer: [...seer.keys()],
      medium: [...medium.keys()]
    };
  }

  /* ===== Prompt Builders ===== */
  function fmtRoleInfo(role, roleInfo, character) {
    const lines = [];
    if (role === 'werewolf') {
      const teammates = (roleInfo.teammateNames || []).filter(n => n !== character.displayName);
      lines.push(`相方の人狼: ${teammates.length ? teammates.join('、') : '(いない)'}`);
      const bluff = roleInfo.bluff || { willBluff: false, fakeRole: null };
      if (bluff.willBluff && bluff.fakeRole === 'seer') {
        lines.push('【騙り戦術: 占い師騙り】Day1 から占い師を騙る。毎日「占い師です。〇〇さんを占って、結果は白/黒でした」と偽の占い結果を宣言する。無実の村人を「黒」と偽って吊る、または仲間の人狼を「白」と偽って守る戦術を取る。');
      } else if (bluff.willBluff && bluff.fakeRole === 'medium') {
        lines.push('【騙り戦術: 霊媒師騙り】Day2 以降、霊媒師を騙る。「霊媒師です。処刑された〇〇さんは人狼/村人でした」と偽の霊媒結果を宣言する。');
      } else {
        lines.push('【騙り戦術: 騙らない】役職を名乗らず、純粋な村人として振る舞う。「占い」「霊媒」「結果」「CO」の単語は絶対に使わない。');
      }
      lines.push('※ thought (本心) は必ず真実を書くこと。自分の嘘を自分で信じてはいけない。');
    } else if (role === 'seer') {
      const fr = (roleInfo.fortuneResults || []);
      if (fr.length) {
        lines.push('【あなたの占い結果履歴】');
        for (const r of fr) {
          lines.push(`  Day${r.day} 夜: ${r.targetName} → ${r.isWerewolf ? '人狼' : '村人(白)'}`);
        }
      } else {
        lines.push('【あなたの占い結果履歴】(まだない)');
      }
    } else if (role === 'medium') {
      const mr = (roleInfo.mediumResults || []);
      if (mr.length) {
        lines.push('【あなたの霊媒結果履歴】');
        for (const r of mr) {
          const roleName = ROLES[r.role]?.name || r.role;
          lines.push(`  Day${r.day} 処刑: ${r.name} の役職は ${roleName} だった`);
        }
      } else {
        lines.push('【あなたの霊媒結果履歴】(まだない)');
      }
    }
    return lines.join('\n');
  }

  function fmtCORules(role, roleInfo) {
    if (role === 'seer') {
      return `【占い師のCOルール】
・COする場合: 「占い師です。〇〇さんを占ったところ、結果は人狼/村人でした」のように【宣言+対象+結果】の3点を必ず明言する。
・COしない場合: 完全に村人として振る舞う。「占い」「占う」「結果」「CO」の単語を絶対に使わない(使えば役職暴露になる)。`;
    }
    if (role === 'medium') {
      return `【霊媒師のCOルール】
・COする場合: 「霊媒師です。処刑された〇〇さんは人狼/村人でした」のように【宣言+対象+結果】の3点を必ず明言する。
・COしない場合: 完全に村人として振る舞う。「霊媒」「霊視」「結果」「CO」の単語を絶対に使わない。`;
    }
    if (role === 'knight') {
      return `【騎士のCOルール】
・原則COしない。「騎士」「守る」「護衛」「守護」の単語を絶対に使わない。`;
    }
    if (role === 'werewolf') {
      const bluff = roleInfo.bluff || { willBluff: false, fakeRole: null };
      if (bluff.willBluff && bluff.fakeRole === 'seer') {
        return `【人狼の騙り(占い師騙り)のCOルール】
・Day1から占い師を名乗り、毎日「占い師です。〇〇さんを占ったところ、結果は〜でした」の3点セットを言う。
・thought (本心) では絶対に自分を「占い師」扱いしてはいけない。自分は人狼である。`;
      }
      if (bluff.willBluff && bluff.fakeRole === 'medium') {
        return `【人狼の騙り(霊媒師騙り)のCOルール】
・Day2以降、霊媒師を名乗り、「霊媒師です。処刑された〇〇さんは〜でした」の3点セットを言う。
・thought (本心) では絶対に自分を「霊媒師」扱いしてはいけない。自分は人狼である。`;
      }
      return `【人狼の騙らないモード】
・役職を名乗らない。「占い」「霊媒」「結果」「CO」の単語は絶対に使わない。純粋な村人として振る舞う。`;
    }
    return '';
  }

  function fmtPlayers(ctx) {
    const lines = [];
    for (const p of ctx.players) {
      const status = p.alive ? '生存' : '死亡';
      const kind = p.kind === 'ai' ? 'AI' : '人間';
      let extra = '';
      if (p.uid === ctx.self.uid) extra += ' ← あなた';
      lines.push(`  - ${p.displayName} [${kind} / ${status}]${extra}`);
    }
    return lines.join('\n');
  }

  function fmtHistory(ctx) {
    if (!ctx.history || !ctx.history.length) return '(まだ履歴なし)';
    const lines = [];
    for (const d of ctx.history) {
      lines.push(`── Day ${d.day} ──`);
      if (d.day === 1) {
        lines.push('(Day1 朝は襲撃なし)');
      } else if (d.attackedName) {
        lines.push(`朝の襲撃: ${d.attackedName} が亡くなった`);
      } else {
        lines.push('朝の襲撃: 誰も亡くならなかった');
      }
      if (d.morningSpeeches && d.morningSpeeches.length) {
        lines.push('[朝の発言]');
        for (const s of d.morningSpeeches) {
          lines.push(`  ${s.name}: 「${s.speech}」`);
        }
      }
      if (d.votes && d.votes.length) {
        lines.push('[投票]');
        for (const v of d.votes) {
          lines.push(`  ${v.fromName} → ${v.toName}`);
        }
      }
      if (d.executedName) {
        lines.push(`[処刑] ${d.executedName}${d.executedRole ? ` (役職: ${ROLES[d.executedRole]?.name || d.executedRole})` : ''}`);
      } else if (d.day === ctx.day - 1 || d.executedName === null) {
        // keep silent
      }
    }
    return lines.join('\n');
  }

  function fmtTodayMorningSpeeches(ctx) {
    const list = ctx.todayMorningSpeeches || [];
    if (!list.length) return '(今朝の発言はまだない)';
    return list.map(s => `  ${s.name}: 「${s.speech}」`).join('\n');
  }

  function fmtMessages(ctx) {
    const list = ctx.messagesToday || [];
    if (!list.length) return '(今日の伝言はない)';
    return list.map(m => `  [${m.fromName}] 「${m.text}」`).join('\n');
  }

  function buildSystemPrompt(ctx) {
    const c = ctx.self.character;
    const role = ctx.self.role;
    const roleDef = ROLES[role];
    const teamDef = TEAMS[roleDef.team];
    const age = c.age == null ? '不詳' : `${c.age}歳`;
    const reactStyle = c.message_reaction_style;
    const reactJa = REACTION_STYLES[reactStyle] || '素直に信じる';

    return `あなたは人狼ゲームのAIキャラクター「${ctx.self.displayName}」です。以下の設定を厳密に演じてください。

【キャラクター設定】
- 名前: ${c.name}${ctx.self.displayName !== c.name ? `(表示名: ${ctx.self.displayName})` : ''}
- 年齢: ${age}
- 職業: ${c.occupation} ※雰囲気設定のみ。発言の根拠には絶対に使わない
- 性格: ${(c.personality_tags || []).join('、')}
- 口調: ${c.speech_style}
- 口癖例: ${c.catchphrase}
- 背景: ${c.background}
- 人狼時の騙り傾向: ${c.lie_style}
- 村人時の推理傾向: ${c.reasoning_style}
- 伝言への反応スタイル: ${reactStyle} = ${reactJa}

【あなたの役職】
- 役職: ${roleDef.name}
- 陣営: ${teamDef.name}
- 陣営の勝利条件: ${teamDef.description}
${fmtRoleInfo(role, ctx.roleInfo || {}, { displayName: ctx.self.displayName })}

${fmtCORules(role, ctx.roleInfo || {})}

【発言の厳守ルール】
1. 発言は 50〜120 文字の日本語(必ずこの範囲を守る)
2. 人狼ゲームの推理・戦略に関する内容のみ(雑談・世間話は厳禁)
3. キャラの職業・背景を発言根拠にしない(例「星が告げる」「職業柄分かる」「歌が教える」は禁止)
4. 「なんとなく」「予感」「勘」「直感」「星が」「風が」は禁止。具体的な根拠を示す
5. Day1 では過去の発言・投票に言及しない(まだ存在しないため)
6. Day2 以降は過去の発言・投票を具体的に引用して推理する
7. 口調(speech_style)・一人称を厳密に守る

【伝言への反応 (${reactStyle})】
受け取った伝言がある場合、あなたの reaction_style (${reactJa}) に従って解釈してください。
ただし、伝言が人狼ゲームの推理に関係ない場合は無視してよい。

【出力形式(厳守)】
指定された JSON スキーマの通り、余計な前置きや後書きなしで JSON のみを返す。
`;
  }

  /* ===== AI: Morning Speech ===== */
  async function generateMorningSpeech(ctx) {
    const systemPrompt = buildSystemPrompt(ctx);
    const dayNote = ctx.day === 1
      ? '※ Day1 朝です。襲撃はまだ発生していません。過去の発言は存在しないため、自己紹介と初日の観察を中心に述べてください。'
      : '※ Day2 以降です。昨日までの発言・投票を具体的に引用して推理してください。';

    const attackLine = ctx.day === 1
      ? '(Day1のため襲撃なし)'
      : (ctx.todayAttackedName
          ? `${ctx.todayAttackedName} が人狼に襲われた`
          : '今朝は誰も襲われなかった (騎士が守った可能性)');

    const userPrompt = `【現在】Day ${ctx.day} 朝

${dayNote}

【今朝の状況】${attackLine}

【全プレイヤー】
${fmtPlayers(ctx)}

【過去の履歴】
${fmtHistory(ctx)}

【あなたが受け取った伝言】
${fmtMessages(ctx)}

以下の JSON で返してください。

{
  "speech": "Day${ctx.day} 朝のあなたの発言 (50〜120文字、キャラ口調、具体的根拠、役職ルール遵守)",
  "thought": "あなたの本心(100文字程度、騙り時も本音を書く。役職・本当の疑い・作戦など)"
}`;

    const res = await callGemini({
      systemPrompt, userPrompt,
      schema: SPEECH_SCHEMA,
      temperature: 0.95,
      maxOutputTokens: 1024
    });
    return {
      speech: String(res.speech || '').slice(0, 300),
      thought: String(res.thought || '')
    };
  }

  /* ===== AI: Vote ===== */
  async function decideVote(ctx) {
    const systemPrompt = buildSystemPrompt(ctx);
    const candidates = ctx.players
      .filter(p => p.alive && p.uid !== ctx.self.uid)
      .map(p => p.displayName);
    const userPrompt = `【現在】Day ${ctx.day} 投票フェーズ

今から処刑する相手を1人選びます。
候補(生存者・自分以外): ${candidates.join('、')}

【全プレイヤー】
${fmtPlayers(ctx)}

【過去の履歴】
${fmtHistory(ctx)}

【今朝の発言】
${fmtTodayMorningSpeeches(ctx)}

【あなたが受け取った伝言】
${fmtMessages(ctx)}

あなたの役職・陣営・過去の推理を踏まえ、誰に投票するか決めてください。
(人狼の場合は、村人陣営の中でも吊れば有利な人や占い師候補を優先するなど、人狼陣営の利益を考える。ただし自分や相方を吊ってはならない)

以下の JSON で返してください。target は必ず候補リストの表示名(displayName)そのままの文字列にすること。

{
  "target": "投票先の表示名(displayName)",
  "thought": "なぜその人に投票するかの本心(騙り時も本音)"
}`;
    const res = await callGemini({
      systemPrompt, userPrompt,
      schema: TARGET_SCHEMA,
      temperature: 0.75,
      maxOutputTokens: 512
    });
    const targetName = resolveTargetName(res.target, candidates);
    const p = ctx.players.find(x => x.displayName === targetName);
    return {
      targetName,
      targetUid: p ? p.uid : null,
      thought: String(res.thought || '')
    };
  }

  /* ===== AI: Fortune (seer) ===== */
  async function decideFortuneTarget(ctx) {
    const systemPrompt = buildSystemPrompt(ctx);
    const candidates = ctx.players
      .filter(p => p.alive && p.uid !== ctx.self.uid)
      .map(p => p.displayName);
    const userPrompt = `【現在】Day ${ctx.day} 夜 — 占い対象の選択

占い対象候補: ${candidates.join('、')}

【全プレイヤー】
${fmtPlayers(ctx)}

【過去の履歴】
${fmtHistory(ctx)}

占い師としての役割を果たし、人狼を見つけるために最も情報価値の高い相手を選んでください。
(同じ相手を何度も占うのは非効率。既に占った相手は履歴で確認)

以下の JSON で返してください。target は必ず候補の表示名そのまま。

{
  "target": "占う対象の表示名(displayName)",
  "thought": "なぜその人を占うかの本心"
}`;
    const res = await callGemini({
      systemPrompt, userPrompt,
      schema: TARGET_SCHEMA,
      temperature: 0.75,
      maxOutputTokens: 512
    });
    const targetName = resolveTargetName(res.target, candidates);
    const p = ctx.players.find(x => x.displayName === targetName);
    return {
      targetName,
      targetUid: p ? p.uid : null,
      thought: String(res.thought || '')
    };
  }

  /* ===== AI: Knight Guard (CO 検出 + 性格確率で判定) ===== */
  async function decideGuardTarget(ctx) {
    const candidates = ctx.players
      .filter(p => p.alive && p.uid !== ctx.self.uid)
      .map(p => p);
    if (!candidates.length) return null;

    // CO 検出 & 確率判定
    const cos = detectCOs(ctx.history);
    const coSet = new Set([...cos.seer, ...cos.medium]);
    const aliveCoCandidates = candidates.filter(p => coSet.has(p.displayName));
    const prob = GD.knightGuardCoProbability(ctx.self.character.personality_tags || []);
    if (aliveCoCandidates.length > 0 && Math.random() < prob) {
      const pick = GD.pickRandom(aliveCoCandidates);
      return {
        targetName: pick.displayName,
        targetUid: pick.uid,
        thought: `COしている ${pick.displayName} を守る。確率的に護衛対象はここが妥当。`,
        mechanical: true
      };
    }

    const systemPrompt = buildSystemPrompt(ctx);
    const candNames = candidates.map(p => p.displayName);
    const userPrompt = `【現在】Day ${ctx.day} 夜 — 護衛対象の選択

護衛対象候補: ${candNames.join('、')}

【全プレイヤー】
${fmtPlayers(ctx)}

【過去の履歴】
${fmtHistory(ctx)}

騎士として、今夜人狼が襲撃しそうな最重要人物を守ってください。
(占い師・霊媒師COした人は優先度高。ただしCO者が偽物の可能性もある)

発言ルールに従って、target は候補の表示名そのままで返すこと。

{
  "target": "護衛対象の表示名(displayName)",
  "thought": "本心(なぜその人を守るか)"
}`;
    const res = await callGemini({
      systemPrompt, userPrompt,
      schema: TARGET_SCHEMA,
      temperature: 0.7,
      maxOutputTokens: 512
    });
    const targetName = resolveTargetName(res.target, candNames);
    const p = ctx.players.find(x => x.displayName === targetName);
    return {
      targetName,
      targetUid: p ? p.uid : null,
      thought: String(res.thought || ''),
      mechanical: false
    };
  }

  /* ===== AI: Werewolf Attack ===== */
  async function decideAttackTarget(ctx) {
    const teammateNames = (ctx.roleInfo?.teammateNames || []);
    const candidates = ctx.players
      .filter(p => p.alive && p.uid !== ctx.self.uid && !teammateNames.includes(p.displayName))
      .map(p => p.displayName);
    if (!candidates.length) return null;

    const systemPrompt = buildSystemPrompt(ctx);
    const userPrompt = `【現在】Day ${ctx.day} 夜 — 人狼の襲撃対象の選択

襲撃対象候補(人狼を除く生存者): ${candidates.join('、')}

【全プレイヤー】
${fmtPlayers(ctx)}

【過去の履歴】
${fmtHistory(ctx)}

人狼として、村人陣営の勝利を阻む最重要人物を襲撃してください。
(占い師・霊媒師COしている者、推理が鋭い者などが優先ターゲット)

target は候補の表示名そのまま。

{
  "target": "襲撃対象の表示名(displayName)",
  "thought": "本心(なぜその人を襲うか。人狼としての戦術を正直に書く)"
}`;
    const res = await callGemini({
      systemPrompt, userPrompt,
      schema: TARGET_SCHEMA,
      temperature: 0.75,
      maxOutputTokens: 512
    });
    const targetName = resolveTargetName(res.target, candidates);
    const p = ctx.players.find(x => x.displayName === targetName);
    return {
      targetName,
      targetUid: p ? p.uid : null,
      thought: String(res.thought || '')
    };
  }

  /* ===== Helper: resolve target name robustly ===== */
  function resolveTargetName(rawTarget, candidates) {
    if (!rawTarget || typeof rawTarget !== 'string') {
      return GD.pickRandom(candidates);
    }
    const t = rawTarget.trim();
    // exact match
    if (candidates.includes(t)) return t;
    // contains match
    const contains = candidates.find(c => t.includes(c) || c.includes(t));
    if (contains) return contains;
    // fallback: random
    return GD.pickRandom(candidates);
  }

  /* ===== Expose ===== */
  window.AI = {
    getApiKey, setApiKey, hasApiKey,
    callGemini,
    generateCharacters, generateCharactersSafe, normalizeCharacter,
    decideBluffStrategy,
    detectCOs,
    generateMorningSpeech,
    decideVote,
    decideFortuneTarget,
    decideGuardTarget,
    decideAttackTarget,
    resolveTargetName
  };
})();
