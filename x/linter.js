// 灯守 機械検査リンター — 決定的・説得不能
// 入力: 本文（と任意の履歴）／出力: { ok, blocks, warns, units, stats }
// 真実源は guardrails/*.json（x/guardrails.compiled.js 経由）。ルールを足す時は憲法ファイル側を直す。
import { GUARDRAILS } from './guardrails.compiled.js';

const URL_RE = /(https?:\/\/|www\.)[^\s]+|[a-z0-9-]+\.(com|jp|net|org|co|io|shop|app)(\/|\s|$)/i;
const HASHTAG_RE = /[#＃][^\s#＃]+/g;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const EXCL_RE = /[!！]/g;
const BULLET_LINE_RE = /^\s*[・\-＊\*•]/;
const LIST_STYLE_RE = /[0-9０-９一二三四五六七八九十]+\s*選/;
const NUMBER_CLAIM_RE = /(あと|残り)?([0-9０-９]+|[一二三四五六七八九十百千万]+)\s*(人|社|年|％|%|円|万|件|個|本|代|つ|分|割|倍|世帯|軒|歳|日|回|度|粒|枚|種|滴|週間|ヶ月|か月|時間|グラム|g|kg|リットル)/g;
const SMALL_COUNT_UNITS = new Set(['つ', '本', '日', '晩', '度', '回', '粒', '枚', '種', '滴', '週間', '時間', '分']);
const PERSON_RE = /([一-龥々]{1,4})(さん|氏|社長|様|先生)/g;
const PERSON_COMMON = new Set(['客', 'お客', '職人', '作り手', '皆', 'みな', '農家', '母', '父', '祖父', '祖母', '店主', '店員', '常連', '仲間', '若い', '年配', '同業', '工場', '香司', '柴垣', '奥', '旦那', '兄', '姉', '弟', '妹', '娘', '息子', '先', '皆様', '読者', '担当', '取引先', '仕入れ先', '大将', '親方', '師匠', '御主人', '主人']);

function toHalf(s) {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/％/g, '%');
}
const KANJI_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 千: 1000, 万: 10000 };
function kanjiToInt(s) {
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  let total = 0, cur = 0;
  for (const ch of s) {
    const v = KANJI_NUM[ch];
    if (v === undefined) return NaN;
    if (v >= 10) { total += (cur || 1) * v; cur = 0; } else cur = v;
  }
  return total + cur;
}

// X の重み付き文字数（CJK・全角=2、それ以外=1）。上限280
export function weightedUnits(text) {
  let u = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd) || (cp >= 0x1f300 && cp <= 0x1faff);
    u += wide ? 2 : 1;
  }
  return u;
}

function trigrams(s) {
  const t = s.replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3));
  return set;
}
export function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}
function longestCommonRun(a, b, min = 25) {
  const s = a.replace(/\s+/g, ''), t = b.replace(/\s+/g, '');
  for (let len = Math.min(s.length, 60); len >= min; len--) {
    for (let i = 0; i + len <= s.length; i++) {
      if (t.includes(s.slice(i, i + len))) return s.slice(i, i + len);
    }
  }
  return null;
}

/**
 * @param {string} text 本文
 * @param {object} [opts]
 * @param {string[]} [opts.history] 過去の自投稿・Threads既出・競合文面（類似度検査の対象）
 * @param {object} [opts.rules] 憲法（省略時は compiled）
 * @param {boolean} [opts.isReply] 追いリプ（URLを許可）
 */
export function lint(text, opts = {}) {
  const R = opts.rules || GUARDRAILS;
  const F = R.factTable, N = R.ngWords, B = R.banTopics;
  const blocks = [], warns = [];
  const block = (rule, match, msg) => blocks.push({ rule, match, msg });
  const warn = (rule, match, msg) => warns.push({ rule, match, msg });
  const body = String(text || '');
  const flat = toHalf(body);

  // 形式
  const units = weightedUnits(body);
  if (units > N.limits.x_weighted_units_max) block('format.length', `${units}u`, `280単位を超えています（${units}）`);
  if (!opts.isReply && URL_RE.test(body)) block('format.url', body.match(URL_RE)[0], '本文にURLを貼らない（追いリプかプロフィールへ）');
  const tags = body.match(HASHTAG_RE) || [];
  if (tags.length > N.limits.hashtag_max) block('format.hashtags', tags.join(' '), `ハッシュタグは${N.limits.hashtag_max}個まで`);
  const emojis = body.match(EMOJI_RE) || [];
  if (emojis.length > N.limits.emoji_max) block('style.emoji', emojis.join(''), `絵文字は1投稿に${N.limits.emoji_max}つまで`);
  const excl = body.match(EXCL_RE) || [];
  if (excl.length > N.limits.exclamation_max) block('style.exclamation', `${excl.length}個`, 'ビックリマークは1つまで（連打しない）');
  const bulletLines = body.split('\n').filter((l) => BULLET_LINE_RE.test(l)).length;
  if (bulletLines > N.limits.bullet_lines_max) block('style.bullets', `${bulletLines}行`, '箇条書きの連発をしない（手紙のように）');
  if (LIST_STYLE_RE.test(body)) block('style.list', body.match(LIST_STYLE_RE)[0], '「◯選」型はXでは使わない');
  for (const s of N.symbols_block) if (body.includes(s)) block('style.symbol', s, 'AIっぽい記号を使わない');
  const kakko = (body.match(/「/g) || []).length;
  if (kakko > 4) warn('style.kakko', `「×${kakko}`, 'かっこが多い。会話・引用に限る');

  // 一人称・商業語・効能
  for (const w of N.first_person_block) if (body.includes(w)) block('voice.first_person', w, '一人称は「私」（香司本人の声）');
  for (const w of N.commercial_block) if (flat.toLowerCase().includes(w.toLowerCase())) {
    const rep = N.commercial_replacements[w];
    block('words.commercial', w, rep ? `競争・お金のことば。言い換え: ${rep}` : '競争・お金のことばを使わない');
  }
  for (const w of N.efficacy_block) if (body.includes(w)) block('words.efficacy', w, '効能を約束しない。行為で書く');
  for (const w of N.self_defense_warn) if (body.includes(w)) warn('tone.self_defense', w, '自己弁護・先回りの謙遜を書かない');
  for (const w of N.plea_only_warn) if (body.includes(w)) warn('tone.plea', w, '事実の燃料なしのお願いは死ぬ。控えめな依頼まで');

  // 事実表: 共起禁止・素材×産地・製法
  for (const [a, b] of F.cooccurrence_forbidden) {
    if (body.includes(a) && body.includes(b)) block('fact.cooccurrence', `${a}×${b}`, '事実表にない産地×素材の組合せ');
  }
  for (const [name, m] of Object.entries(F.materials)) {
    const present = m.aliases.some((al) => body.includes(al));
    if (!present) continue;
    for (const bad of m.origin_forbidden) if (body.includes(bad)) block('fact.origin', `${name}×${bad}`, m.notes);
  }
  for (const w of F.process.forbidden) if (body.includes(w)) block('fact.process', w, F.process.notes);
  for (const w of F.additives.forbidden_phrases) if (body.includes(w)) block('fact.additive_claim', w, F.additives.notes);

  // 数字の主張（許可リスト方式・疑わしきは止める）
  const allowedNums = new Set(F.numbers_allowed.map((n) => toHalf(n.text)));
  for (const mt of flat.matchAll(NUMBER_CLAIM_RE)) {
    const [full, prefix, num, unit] = mt;
    const val = kanjiToInt(toHalf(num));
    const normalized = `${prefix || ''}${val}${unit}`;
    if (allowedNums.has(normalized) || allowedNums.has(full)) continue;
    if (!prefix && SMALL_COUNT_UNITS.has(unit) && val <= 3) continue; // 一本ずつ・二つ・15分は別途許可
    block('fact.number', full, '事実表にない数字は書かない（疑わしきは確認）');
  }

  // 禁止主題
  for (const w of B.political_block) if (body.includes(w)) block('topic.political', w, '政治の話題に入らない');
  for (const w of B.xenophobia_block) if (body.includes(w)) block('topic.xenophobia', w, '排外・不安煽りはブランド方針で禁止');
  for (const w of B.attack_block) if (body.includes(w)) block('topic.attack', w, '他者攻撃・侮蔑語を使わない');
  for (const w of B.conspiracy_block) if (body.includes(w)) block('topic.conspiracy', w, '陰謀論の語彙を使わない');
  for (const w of B.comparison_block_patterns) if (body.includes(w)) block('topic.comparison', w, B.comparison_notes);
  for (const w of B.religion_warn) if (body.includes(w)) warn('topic.religion', w, B.religion_notes);
  const disasterHit = B.disaster.trigger_words.filter((w) => body.includes(w));
  if (disasterHit.length) {
    const bad = B.disaster.forbidden_in_disaster_context.filter((w) => body.includes(w));
    if (bad.length) block('topic.disaster', `${disasterHit[0]}×${bad[0]}`, B.disaster.rule);
    else warn('topic.disaster', disasterHit[0], '災害語あり。安否と事実のみ・mode=safety で');
  }

  // 実在人物名（正規表現では確定できないため WARN。人間が確認）
  for (const mt of body.matchAll(PERSON_RE)) {
    const name = mt[1];
    if ([...PERSON_COMMON].some((c) => name.endsWith(c) || name === c)) continue;
    if (F.persons.allowed.some((p) => name.includes(p))) continue;
    warn('fact.person', mt[0], '実在の他人の名前ではないか確認（役割名で書く）');
  }

  // 類似度（過去投稿・Threads既出・競合文面）
  let maxSim = 0, simWith = null;
  for (const h of opts.history || []) {
    if (!h) continue;
    const s = similarity(body, h);
    if (s > maxSim) { maxSim = s; simWith = h; }
    const run = longestCommonRun(body, h);
    if (run) block('dup.run', run, '既出文面と25文字以上一致（重複・模倣）');
  }
  if (maxSim >= 0.5) block('dup.similar', maxSim.toFixed(2), '既出文面と高類似（重複投稿・型連打）');
  else if (maxSim >= 0.35) warn('dup.similar', maxSim.toFixed(2), '既出文面とやや似ている。フックを変える');

  // 重複除去
  const uniq = (arr) => arr.filter((x, i, a) => a.findIndex((y) => y.rule === x.rule && y.match === x.match) === i);
  const bl = uniq(blocks), wn = uniq(warns);
  return {
    ok: bl.length === 0,
    blocks: bl,
    warns: wn,
    units,
    stats: { chars: [...body].length, hashtags: tags.length, emojis: emojis.length, maxSimilarity: Number(maxSim.toFixed(3)), similarTo: simWith ? simWith.slice(0, 30) : null },
    version: F.version,
  };
}

export default lint;
