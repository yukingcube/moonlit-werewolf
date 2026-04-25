/* ============================================================
   js/gameData.js
   定数、役職定義、フォールバックキャラ12人、ユーティリティ関数
   ============================================================ */
'use strict';

/* ---------- 設定 ---------- */
const CONFIG = {
  VERSION: '0.5',
  TOTAL_PLAYERS: 7,
  MAX_DAY: 10,
  DISCUSSION_TIME_SEC: 180,
  DISCUSSION_TIME_DEAD_SEC: 15,
  EXECUTION_WAIT_MS: 4000,
  MORNING_SPEECH_DELAY_MS: 1800,
  VOTE_TIMEOUT_MS: 60000,
  READY_POLL_INTERVAL_MS: 500,
  MESSAGE_MAX_LENGTH: 100,
  AI_SPEECH_MIN_LENGTH: 50,
  AI_SPEECH_MAX_LENGTH: 120,
  NAME_MAX_LENGTH: 12,
  ROOM_ID_LENGTH: 6,

  GEMINI_MODEL_PRIMARY: 'gemini-2.5-flash',
  GEMINI_MODEL_FALLBACK: 'gemini-2.5-flash-lite',
  GEMINI_MAX_RETRIES: 4,
  GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/models',

  API_KEY_STORAGE: 'gemini_api_key',
  PLAYER_NAME_STORAGE: 'player_name',

  ROLE_COUNTS: { werewolf: 2, seer: 1, knight: 1, medium: 1, villager: 2 }
};

/* ---------- 役職 ---------- */
const ROLES = {
  werewolf: {
    id: 'werewolf', name: '人狼', team: 'werewolf', icon: '狼',
    description: '夜に1人を襲撃し、村を支配せよ'
  },
  seer: {
    id: 'seer', name: '占い師', team: 'villager', icon: '眼',
    description: '夜に1人を占い、人狼か否かを見抜く'
  },
  knight: {
    id: 'knight', name: '騎士', team: 'villager', icon: '盾',
    description: '夜に1人を選び、人狼の襲撃から守る'
  },
  medium: {
    id: 'medium', name: '霊媒師', team: 'villager', icon: '鈴',
    description: '前日処刑された者の役職を知る'
  },
  villager: {
    id: 'villager', name: '村人', team: 'villager', icon: '民',
    description: '特殊能力はない。議論と投票で村を守れ'
  }
};

const TEAMS = {
  villager: { id: 'villager', name: '村人陣営', description: '人狼を全員処刑すれば勝利' },
  werewolf: { id: 'werewolf', name: '人狼陣営', description: '人狼の数が村人以上になれば勝利' }
};

/* ---------- 伝言反応スタイル ---------- */
const REACTION_STYLES = {
  straightforward: '素直に信じる',
  skeptical: '疑い深く、送り主自体を疑う',
  contrarian: '天邪鬼で、逆の方向に動く',
  logical: '論理性のみで評価する',
  emotional: '口調の強さに流される'
};

const REACTION_STYLE_IDS = Object.keys(REACTION_STYLES);

/* ---------- フォールバックキャラ(12人) ---------- */
const FALLBACK_CHARACTERS = [
  {
    name: 'アリア', age: 22, occupation: '吟遊詩人',
    personality_tags: ['明朗', '好奇心', '感情的'],
    speech_style: 'わたし / 柔らかく明るく弾む口調',
    catchphrase: '歌が全てを教えてくれるのよ。',
    background: '各地を旅する吟遊詩人。人の心の機微を感じ取るのが得意。',
    lie_style: '感情に訴えて場をかき乱す。涙目や怒りを巧みに使う',
    reasoning_style: '直感と相手の表情・声色の変化を頼りに推理する',
    message_reaction_style: 'emotional'
  },
  {
    name: 'ヴォルフ', age: 34, occupation: '猟師',
    personality_tags: ['寡黙', '冷静', '頑強'],
    speech_style: '俺 / ぶっきらぼうで短く切る口調',
    catchphrase: '…足跡は嘘をつかない。',
    background: '森で一人暮らす無口な猟師。獣を追って生きてきた。',
    lie_style: '言葉少なに沈黙で押し通し、核心を避ける',
    reasoning_style: '発言の矛盾や投票履歴から冷静に追い詰める',
    message_reaction_style: 'logical'
  },
  {
    name: 'エルザ', age: 28, occupation: '司祭',
    personality_tags: ['慈悲深い', '誠実', '責任感'],
    speech_style: 'わたくし / 穏やかで丁寧な敬語',
    catchphrase: '主よ、この村をお導きください。',
    background: '村の教会を守る若い司祭。迷える者の相談役。',
    lie_style: '嘘が下手で動揺が出やすい。敢えて慈悲を装う',
    reasoning_style: '皆の発言を丁寧に聞き、誠実さで信じる相手を判断する',
    message_reaction_style: 'straightforward'
  },
  {
    name: 'ブルーノ', age: 45, occupation: '鍛冶屋',
    personality_tags: ['頑固', '大胆', '豪快'],
    speech_style: '俺 / 荒々しく大声で断定する口調',
    catchphrase: 'ふん、俺の目は節穴じゃねえぞ。',
    background: '村で唯一の鍛冶屋。腕は確かだが気難しく皮肉屋。',
    lie_style: '堂々と言い切る。矛盾を指摘されても意地で貫き通す',
    reasoning_style: '自分の第一印象を押し通し、一度疑った相手は撤回しない',
    message_reaction_style: 'contrarian'
  },
  {
    name: 'カミラ', age: 31, occupation: '薬師',
    personality_tags: ['慎重', '観察力', '疑い深い'],
    speech_style: '私 / 冷ややかで鋭く刺す口調',
    catchphrase: '毒は甘い顔をして近づくわ。',
    background: '村の薬草を扱う女薬師。人間不信の気がある。',
    lie_style: '他人を疑わせることで自分から目を逸らす',
    reasoning_style: '発言の小さな違和感を見逃さず執拗に追及する',
    message_reaction_style: 'skeptical'
  },
  {
    name: 'ディーター', age: 27, occupation: '兵士',
    personality_tags: ['責任感', '真面目', '誠実'],
    speech_style: '自分 / 規律正しい軍人口調',
    catchphrase: '自分は村を守る義務があります。',
    background: '退役した若い兵士。村の警備を志願した。',
    lie_style: '命令遂行として割り切る。感情を見せず淡々と',
    reasoning_style: '状況証拠と発言の整合性を軍の報告書のように整理する',
    message_reaction_style: 'straightforward'
  },
  {
    name: 'エヴァ', age: null, occupation: '星読み師',
    personality_tags: ['神秘的', '知的', '論理的'],
    speech_style: '私 / 落ち着いた低い声で淡々と',
    catchphrase: '事実のみが道を照らす。',
    background: '年齢不詳の女性。星を読み運命を語るが、推理は冷徹。',
    lie_style: '論理の隙を突いて煙に巻く。断定は避けてぼかす',
    reasoning_style: '全員の発言を論理的に突き合わせ矛盾を洗い出す',
    message_reaction_style: 'logical'
  },
  {
    name: 'フェリクス', age: 38, occupation: '行商人',
    personality_tags: ['狡猾', '口八丁', '計算高い'],
    speech_style: 'あっし / 愛想のいい商人口調',
    catchphrase: 'まぁまぁ、話は最後まで聞いておくんなせえ。',
    background: '諸国を巡る行商人。口が上手く人を誘導するのが得意。',
    lie_style: '饒舌にもっともらしい嘘を重ね、場の流れを作る',
    reasoning_style: '人の損得勘定から動機を推測し、弱みを突く',
    message_reaction_style: 'skeptical'
  },
  {
    name: 'グレーテ', age: 20, occupation: '農婦',
    personality_tags: ['素直', '純粋', '感情的'],
    speech_style: 'うち / 素朴で温かい田舎の言葉',
    catchphrase: 'うちは……怖くて仕方ないだよ。',
    background: '村外れの農家の娘。純朴で素直な性格。',
    lie_style: '嘘が下手ですぐ泣きそうになる。涙で誤魔化そうとする',
    reasoning_style: '誰かの声の震えや表情で怪しいと感じる',
    message_reaction_style: 'emotional'
  },
  {
    name: 'ハインリヒ', age: 42, occupation: '書記官',
    personality_tags: ['分析的', '几帳面', '冷静'],
    speech_style: '私 / 論理的で淡々と事実を並べる',
    catchphrase: '記録に残すべき事実を整理しましょう。',
    background: '村の書記を務める知的な男。全ての発言を記録する習性。',
    lie_style: '数字や記録を盾にもっともらしく言い逃れる',
    reasoning_style: '過去全ての発言と投票を記録し、矛盾を論理的に指摘する',
    message_reaction_style: 'logical'
  },
  {
    name: 'イザベラ', age: 25, occupation: '没落貴族の令嬢',
    personality_tags: ['傲慢', '気まぐれ', '天邪鬼'],
    speech_style: 'わたくし / 高飛車で皮肉交じりの口調',
    catchphrase: 'あら、あなた本気でそれを信じるの?',
    background: '落ちぶれた貴族の令嬢。プライドだけは高い。',
    lie_style: '相手を小馬鹿にして論点をずらす。意地を通す',
    reasoning_style: '多数派に同調せず、皆が信じる者ほど疑ってかかる',
    message_reaction_style: 'contrarian'
  },
  {
    name: 'ヨハン', age: 19, occupation: '旅の学生',
    personality_tags: ['純粋', '愚直', '誠実'],
    speech_style: '僕 / 丁寧でまっすぐな口調',
    catchphrase: '正直に話せば、きっと分かり合えるはずです。',
    background: '学問のために村を訪れた若い学生。人を疑うことを知らない。',
    lie_style: '嘘がへたくそ。すぐ目が泳ぐが、真剣に貫こうとする',
    reasoning_style: '人の善意を信じつつ、教科書的な論理で推理する',
    message_reaction_style: 'straightforward'
  }
];

/* ---------- ユーティリティ ---------- */
function generateRoomId() {
  const digits = '0123456789';
  let id = '';
  for (let i = 0; i < CONFIG.ROOM_ID_LENGTH; i++) {
    id += digits[Math.floor(Math.random() * 10)];
  }
  return id;
}

function shuffleArray(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickRandomN(arr, n) {
  return shuffleArray(arr).slice(0, n);
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&#39;');
}

function formatAge(age) {
  if (age == null || age === '' || age === '不詳') return '不詳';
  return `${age}歳`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function buildRolePool() {
  const pool = [];
  for (const [role, count] of Object.entries(CONFIG.ROLE_COUNTS)) {
    for (let i = 0; i < count; i++) pool.push(role);
  }
  return pool;
}

/* 名前重複時のサフィックス付与 (A/B/C…) — 既知課題#3 対応 */
function disambiguateNames(players) {
  const counts = new Map();
  for (const p of players) counts.set(p.name, (counts.get(p.name) || 0) + 1);
  const assigned = new Map();
  return players.map(p => {
    const total = counts.get(p.name) || 0;
    if (total <= 1) return { ...p, displayName: p.name };
    const idx = assigned.get(p.name) || 0;
    assigned.set(p.name, idx + 1);
    const letter = String.fromCharCode('A'.charCodeAt(0) + idx);
    return { ...p, displayName: `${p.name}(${letter})` };
  });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function makeUid() {
  return 'local_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function deepClone(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  return JSON.parse(JSON.stringify(obj));
}

/* ---------- ランダム性格補助 ---------- */
function isSlyPersonality(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some(t => /狡猾|策略|大胆|口八丁|計算高|傲慢|天邪鬼|皮肉/.test(t));
}
function isHonestPersonality(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some(t => /素直|純粋|愚直|誠実|真面目|慈悲/.test(t));
}
function isCautiousPersonality(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some(t => /疑い深|慎重|観察/.test(t));
}
function isLogicalPersonality(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some(t => /論理|冷静|分析|知的|几帳面/.test(t));
}
function isResponsiblePersonality(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some(t => /誠実|真面目|責任感|素直/.test(t));
}

/* 人狼の騙り確率(仕様書4.8) */
function bluffProbability(tags) {
  if (isSlyPersonality(tags)) return 0.75;
  if (isHonestPersonality(tags)) return 0.15;
  return 0.40;
}

/* 騎士のCO者護衛確率(仕様書4.9) */
function knightGuardCoProbability(tags) {
  if (isResponsiblePersonality(tags)) return 0.85;
  if (isCautiousPersonality(tags)) return 0.40;
  if (isLogicalPersonality(tags)) return 0.65;
  return 0.60;
}

/* ---------- フェーズ名 ---------- */
const PHASES = Object.freeze({
  TITLE: 'title',
  SETTINGS: 'settings',
  MODE: 'mode',
  ROOM: 'room',
  LOBBY: 'lobby',
  CHARACTERS: 'characters',
  ROLE: 'role',
  NIGHT: 'night',
  MORNING: 'morning',
  DISCUSSION: 'discussion',
  VOTE: 'vote',
  EXECUTION: 'execution',
  RESULT: 'result',
  THOUGHT_LOG: 'thought-log'
});

/* ---------- グローバル公開 ---------- */
window.GameData = {
  CONFIG, ROLES, TEAMS, REACTION_STYLES, REACTION_STYLE_IDS,
  FALLBACK_CHARACTERS, PHASES,
  generateRoomId, shuffleArray, pickRandom, pickRandomN,
  formatTime, escapeHtml, formatAge, sleep,
  buildRolePool, disambiguateNames, clamp, makeUid, deepClone,
  isSlyPersonality, isHonestPersonality, isCautiousPersonality,
  isLogicalPersonality, isResponsiblePersonality,
  bluffProbability, knightGuardCoProbability
};
