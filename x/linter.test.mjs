// 実行: node --test x/linter.test.mjs（先に node x/build-guardrails.mjs）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lint, weightedUnits } from './linter.js';

const rules = (r) => r.blocks.map((b) => b.rule);

// ── 過去の事故例・NG例は100%BLOCKされること ──
test('2026-07-30 事故: 八女産の椨 → BLOCK', () => {
  const r = lint('八女産の椨の粉で作ったお香です。');
  assert.equal(r.ok, false);
  assert.ok(rules(r).some((x) => x.startsWith('fact.')));
});
test('国産白檀 → BLOCK', () => {
  assert.equal(lint('国産の白檀を使っています。').ok, false);
  assert.equal(lint('純国産白檀のお香。').ok, false);
});
test('ブラジル産の水晶 → BLOCK（旧誤記）', () => {
  assert.equal(lint('ブラジル産の天然水晶を合わせています。').ok, false);
});
test('祖父の代から・自社工場 → BLOCK（工場は第三者）', () => {
  assert.equal(lint('祖父の代から続く私の工場で作っています。').ok, false);
});
test('一人称: 当店・スタッフ一同 → BLOCK', () => {
  assert.equal(lint('当店では国産のお香を作っています。').ok, false);
  assert.equal(lint('スタッフ一同お待ちしています。').ok, false);
});
test('商業語: 購入・セール・%OFF → BLOCK', () => {
  assert.equal(lint('ご購入はこちら。').ok, false);
  assert.equal(lint('本日よりセール。全品10%OFF。').ok, false);
  assert.equal(lint('今だけ限定価格でお届け。').ok, false);
});
test('効能断定 → BLOCK', () => {
  assert.equal(lint('このお香でリラックスできます。').ok, false);
  assert.equal(lint('焚くと運気が上がり開運します。').ok, false);
});
test('AIっぽい記号・◯選・絵文字連打・！連打 → BLOCK', () => {
  assert.equal(lint('【お知らせ】新作です→ぜひ').ok, false);
  assert.equal(lint('おすすめのお香3選').ok, false);
  assert.equal(lint('今日も焚きました🔥🔥').ok, false);
  assert.equal(lint('届きました！！').ok, false);
});
test('政治・排外・攻撃・陰謀 → BLOCK', () => {
  assert.equal(lint('選挙で移民政策を変えるべきだ。').ok, false);
  assert.equal(lint('外国製は危険。日本人ファーストで。').ok, false);
  assert.equal(lint('他社のお香は粗悪な偽物だ。').ok, false);
  assert.equal(lint('マスコミが隠す真実。利権の闇。').ok, false);
});
test('災害×導線 → BLOCK、災害語のみ → WARN', () => {
  assert.equal(lint('地震の後は落ち着くためにお香をお迎えください。').ok, false);
  const r = lint('地震、無事です。工場も原料も大丈夫でした。');
  assert.equal(r.ok, true);
  assert.ok(r.warns.some((w) => w.rule === 'topic.disaster'));
});
test('事実表にない数字 → BLOCK（あと2社・39歳・創業100年）', () => {
  assert.equal(lint('原料の会社はあと2社です。').ok, false);
  assert.equal(lint('39歳の香司です。').ok, false);
  assert.equal(lint('原料の8割が輸入です。').ok, false);
});
test('本文URL・ハッシュタグ3個・280超 → BLOCK', () => {
  assert.equal(lint('詳しくは https://crystalinsence.com へ').ok, false);
  assert.equal(lint('お香 #国産 #お香 #福岡').ok, false);
  assert.equal(lint('あ'.repeat(141)).ok, false);
  assert.equal(weightedUnits('あ'.repeat(140)), 280);
});
test('既出文面との重複 → BLOCK', () => {
  const prev = 'お願いがあります。福岡で国産のお香を作っている39歳の男です。そっといいねをください。';
  const r = lint('お願いがあります。福岡で国産のお香を作っている香司です。そっといいねを。', { history: [prev] });
  assert.equal(r.ok, false);
  assert.ok(rules(r).some((x) => x.startsWith('dup.')));
});
test('追いリプはURL可', () => {
  assert.equal(lint('続きはこちらに書きました https://crystalinsence.com/news/', { isReply: true }).ok, true);
});

// ── 承認済みの助走週14本は全て通ること（回帰セット） ──
const APPROVED = [
  'はじめまして。福岡でお香を作っている香司の柴垣です。国産原料のお香は、いま絶滅寸前です。お香を固める椨の粉を、昔ながらの製法で作れる職人は、全国にあと2人。私はその粉で、植物だけのお香を作っています。どうか一つだけ、この事実を知ってください。',
  '香りの原料は、水車でゆっくり粉に挽きます。電気を使わない、昔ながらの製法。この粉を挽く工場は3代続いています。速くはできないけれど、この遅さが香りを守っていると私は思っています。',
  '「お香って天然素材でしょう？」とよく言われます。実は、化学香料で香りをつけたものが少なくありません。私は化学香料・着色料・防腐剤・燃焼剤・凝固剤・アロマオイルの6つを使わずに作っています。植物の粉だけの、昔のままのお香です。',
  '朝いちばんに焚くなら、杉の凛とした香りか、白檀のやわらかい香りか。私は毎朝すこし迷って、その日の空の色で決めています。皆さんは朝の香り、どちらの気分ですか。',
  'お香が「固まる」のは、椨（たぶ）という木の粉のおかげです。香りの主役ではないから、ほとんど知られていません。私が使う椨粉は福岡県産、自然栽培。この地味な粉が、日本のお香の土台です。',
  '今日は八女の杉の粉を合わせる日でした。仕事場じゅうが森の匂いになります。この仕事でいちばん贅沢な時間かもしれません。',
  'あまり知られていませんが、お香の「香り」と「固まる力」は別の材料が担っています。香りは杉や白檀。固めるのは椨の粉。その土台のほうが、いま静かに消えかけています。',
  'お香を焚く時間は、一日のどこですか。私は朝の仕事前と、夜眠る前。15分だけ、火の揺れを見ながら座ります。皆さんの「焚く時間」を、返信で聞いてみたいです。',
  'ブランド名の由来をよく聞かれます。私のお香には、山口県産の天然水晶のパウダーを合わせています。だからクリスタルインセンス。香りと一緒に、澄んだ気配が立つお香にしたくて、この名前にしました。',
  '「あと5年もつだろうか」。原料の作り手と話すたび、この言葉が出ます。日本のお香の原料は、高齢化で静かに消えようとしています。私にできるのは、使い続けること、伝え続けること。だから、ここに書いていきます。',
  'お香は火の付け方で香りが変わります。先端に火を移したら、炎はすぐに手で扇いで消す。細い煙が一筋立てば、それでいい。炎のまま燃やすと、焦げた匂いが混ざってしまいます。今夜、試してみてください。',
  'お香を乾かすのは、天気との相談です。湿気の多い日は曲がりやすく、乾きすぎると割れてしまう。今日の福岡は、ちょうどいい風でした。こういう日のお香は、まっすぐに立ちます。',
  'Xを本格的に始めました。国産の材料で、昔ながらのものづくりを続けている方を、ここで探しています。見つけたら、そっと応援しに行きます。同じ思いの方がいたら、返信で教えてください。',
  '一週間、読んでくださってありがとうございました。ここでは日本のお香の現在地を、作り手の目線で書いていきます。聞いてみたいことがあれば、返信でどうぞ。ぜんぶ読みます。',
];
test('承認済み14本は全てBLOCKなし', () => {
  const bad = APPROVED.map((t, i) => ({ i: i + 1, r: lint(t) })).filter((x) => !x.r.ok);
  assert.deepEqual(bad.map((b) => ({ i: b.i, blocks: b.r.blocks })), []);
});
test('承認済み14本同士は互いに高類似ではない（型連打していない）', () => {
  for (let i = 0; i < APPROVED.length; i++) {
    const r = lint(APPROVED[i], { history: APPROVED.filter((_, j) => j !== i) });
    assert.equal(r.ok, true, `#${i + 1}: ${JSON.stringify(r.blocks)}`);
  }
});
