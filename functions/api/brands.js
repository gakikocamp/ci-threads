// GET /api/brands … デイリーエンジン（Mac Studio）が毎朝読むブランド別の設定
// ここを直して push すれば、翌朝からエンジンの判定・生成ルールが変わる（Mac Studio 側の改修は不要）
// ?id=karen のように1ブランドだけ取得も可
const SYNC_KEY = 'ci-threads-sync-v1'; // 簡易ボット避け（クライアントに埋め込むため秘密ではない）
const UPDATED = '2026-09-24';

// 全ブランド共通：CIの条件統制つき実験（2026-09-10 ❤4,124 vs ❤111/❤244）で確定した型
const EQUATION = {
  body: '本文は4〜6行・55〜90字。空行で区切る',
  line1: '1行目＝読者が「わかる」と頷ける価値観の断言（自分の話・告知・説明から入らない）',
  ask: '依頼は最小に（「いいねだけ」「そっといいねを」程度）。フォローや申込のお願いは本文に書かない',
  spread_fuel: '本文に、他人へ伝えたくなる確認済みの燃料を必ず1つ入れる（知られていない事実・具体的な数字・失われる危機・意外な対比のいずれか）。価値観といいね依頼だけで終わらせない',
  signature: '最終行は署名だけ（signature を使う）',
  reply: '日時・料金・URL・経緯などの説明はすべて追いリプへ移す',
  measurement: 'いいね率は共感、再投稿・引用・シェア率は配信拡大として分けて評価する。いいね率だけでバズ確度を上げない',
  evidence: 'CI実測: 読者向け1行目の中央値❤3,291 vs 自分向け❤204（16倍）／4行55字❤4,124 vs 230字❤111。2026-09-12白檀はいいね率11.75%でも再投稿率0.06%・閲覧3,217で停止。一方、椨あと2人はいいね率12.8%・再投稿率0.17%・閲覧116,475'
};

const COMMON_NG = [
  '事実表（facts）にない数字・実績・人名・体験談を書かない（創作の禁止）',
  '誇大表現（絶対・必ず・最強・No.1）、値引きや％オフの表現',
  'emダッシュ（—）、「〜というのは〜ということです」のような中身のない構文',
  '自己弁護・先回りの謙遜（「煽っているように聞こえたらごめんなさい」等）',
  '政治・排外・特定の人や地域を下げる比較',
  '確認済みの事実や数字がない「価値観＋そっといいね」だけの投稿（共感は取れても再投稿されず配信が止まる）',
  '直近7日の候補・投稿と同じ1行目の型を連投しない'
];

// 閾値は初期値。毎週月曜に各アカウントの直近20件（確定分）の❤中央値で上方修正する
const RECALIBRATE = 'weekly(月): buzz=max(初期buzz, 中央値×5) / ok=max(初期ok, 中央値×1.5)。24時間未満はpending';

// 成功の定義（2026-09-18 柴垣さん指摘で変更。❤だけで勝ち型を決めない）
const SUCCESS = {
  primary: '投稿後24時間の「フォロワー増」。次に、売上・申込・問い合わせにつながる行動（プロフィール経由の購入、DM、申込）',
  secondary: '❤・再投稿・返信は「どれだけ配信されたか」を見る副指標。目的ではない',
  cap_rule: '❤が buzz 閾値を超えても、その24時間のフォロワー増が0なら result は ok 止まりにする。theme に「(フォロワー+0)」と明記する',
  off_topic: '本業（お香・キャンピングカー・イベント集客・起業相談）と関係ないテーマは、❤が伸びても勝ち型として学習しない。insight_summary に「学習対象外（テーマ不一致）」と理由を書く',
  evidence: '2026-09-18 @gakikocamp「なぜ日本はこんなに貧乏な国になってしまったのだろうか。」が❤1,886・返信282・再投稿55まで伸びたが、フォロワー増なし・売上なし（柴垣さん確認）。バズ＝成功ではない',
  tracking: '毎日すべてのアカウント（@crystal_insence / @gakikocamp を含む）のフォロワー数を取得し、POST /api/followers に {brand, handle, date, followers} を送って記録する（deltaは自動計算）。前日差は insight_summary にも残す。投稿があった日は、その日のdeltaを当日の投稿に紐づけて評価する',
  tracking_note: '未ログインの公開プロフィールは1万人以上が「5万人」のように丸められる。@crystal_insence の正確なフォロワー数と増減は、ログイン状態のインサイトから取ること。取れない日は followers を送らず、insight_summary に「フォロワー未取得」と書く'
};

// 実機で検証済みの取得関数（2026-09-24 MacBook のブラウザで13投稿を実測。例: DdaYLIrkusP 13/1/1、DdmAlF9kxw_ 350/2/5）
// 個別投稿ページ https://www.threads.com/@<handle>/post/<id> を開いた状態で page.evaluate(fn, id) として使う
async function threadsPostMetrics(id) {
  function cardOf(pid) {
    const a = [...document.querySelectorAll('a[href*="/post/' + pid + '"]')][0];
    if (!a) return null;
    let c = a;
    while (c.parentElement) {
      const p = c.parentElement;
      const ids = new Set([...p.querySelectorAll('a[href*="/post/"]')]
        .map(x => (x.getAttribute('href').match(/\/post\/([A-Za-z0-9_-]+)/) || [])[1]).filter(Boolean));
      if (ids.size > 1) break;
      c = p;
    }
    return c;
  }
  let card = null;
  for (let i = 0; i < 20 && !(card = cardOf(id)); i++) await new Promise(r => setTimeout(r, 250));
  if (!card) return { id, error: 'card not found' };
  const svgs = [...card.querySelectorAll('svg')];
  const last = svgs.slice(-4);
  if (last.length < 4) return { id, error: 'action bar not found (quote post?)' };
  let bar = last[0];
  while (bar && !last.every(sv => bar.contains(sv))) bar = bar.parentElement;
  const slots = bar ? [...bar.children].map(ch => (ch.innerText || '').trim()) : [];
  if (slots.length !== 4) return { id, error: 'unexpected action bar', slots };
  const n = v => {
    if (!v) return 0; // 0件の欄は数字が表示されない
    const t = v.replace(/,/g, '');
    return /万/.test(t) ? Math.round(parseFloat(t) * 10000) : (parseInt(t, 10) || 0);
  };
  const time = card.querySelector('time');
  const imgs = [...card.querySelectorAll('img')].filter(im => (im.naturalWidth || im.width) > 150).length;
  return { id, postedAt: time ? time.getAttribute('datetime') : null, like: n(slots[0]), reply: n(slots[1]), repost: n(slots[2]), share: n(slots[3]), hasImage: imgs > 0 };
}

// 収集の健全性ルール（2026-09-18 追加。全件0で返る収集不具合を検知して学習データの汚染を防ぐ）
const COLLECTION = {
  fact: '未ログインの公開プロフィールでも ❤・返信・再投稿は表示される（2026-09-18 に @crystal_insence / @gakikocamp / @konnichiwa.karen / @startupkyushu で実機確認）。したがって「未ログインだから数値が0」は誤り',
  detect: '収集した自社投稿の likes が全件0、または followers が取得できないのに過去に実測があるアカウントは「収集失敗」と判定する',
  on_failure: [
    '/api/results には1件も送らない（0を miss として記録すると実測が汚染される）',
    'insight_summary の先頭に「収集失敗」と明記し、原因（セレクタ・描画待ち・ログイン）を1行で書く',
    '翌日の実行で取りこぼし分を再取得する（24時間を過ぎていても未登録なら判定してよい）'
  ],
  fallback: '投稿カードの innerText を行に分割し、「行全体が数字だけ」の行を上から likes / replies / reposts として拾う。2026-09-18 に4アカウントで有効性を確認済み（例: 307 / 22 / 16）。セレクタが壊れてもこの方法で拾えるなら収集を続行する',
  exception: 'followers が 0 のアカウント（例: vantripjapan）は、表示にも数字が無ければ本当に0。この場合だけ0として記録してよい',
  login: {
    account: 'Mac Studio の Chrome は @crystal_insence だけログインしておく（売上が立つアカウント。他の4アカウントは公開ページで正確な数が取れるためログイン不要）',
    gives: 'CIの正確なフォロワー数と前日差、投稿ごとの閲覧数・リーチ（現在はすべて view:na で取れていない）',
    read_only: 'ログイン状態でも、いいね・フォロー・投稿・返信・DM・プロフィール編集は絶対に行わない。読むだけ。投稿は本人がアプリからコピーして行う',
    not_a_fix: '2026-09-18の「全件0」はログインの問題ではない（未ログインでも公開ページには数値が出る）。パーサーの不具合として別途直すこと',
    on_logout: 'ログインが切れていたら、CIの閲覧数とフォロワー数は送らず、insight_summary の先頭に「CI未ログイン」と書く。他ブランドの公開数値の収集は続ける'
  },
  self_repair: {
    trigger: '前日の insight_summary が「収集失敗」で始まっていたら（2日続けて失敗）、この実行では判定・生成より先に collector.js を修理する。~/ci-daily-engine 内のファイルは編集してよい（投稿・いいね・フォロー等の操作は引き続き禁止）',
    steps: [
      'collector.js を collector.js.bak-<今日の日付> にコピーする',
      '数値の取り方を extractor（下の関数）に置き換える。各投稿の個別ページ https://www.threads.com/@<handle>/post/<id> を開き、page.evaluate(extractor, id) で like / reply / repost / share / postedAt / hasImage を取る',
      'プロフィール一覧からは投稿IDだけを集め、24時間以上10日以内の未登録投稿だけ個別ページで数値を取る（プロフィール一覧のカードは引用や固定投稿で境界がずれるため数値を読まない）',
      'フォロワー数はプロフィールの「フォロワーN人」から取り、POST /api/followers に送る（1万人以上は丸め表示なので送らない。CIはログイン時のインサイトから）',
      'extractor が error を返した投稿（引用投稿など）は記録せず保留にする',
      'node collector.js で再収集し、verify に通れば新しいJSONで判定・生成を続ける'
    ],
    extractor: threadsPostMetrics.toString(),
    verify: '@konnichiwa.karen の固定投稿 DMPDV04xMMD が like 約307 / reply 約22 / repost 約17 で取れること（2026-09-24 実測）',
    rollback: '検証に通らなければバックアップに戻し、insight_summary の先頭に「自己修理失敗」と原因を書いて、その日は results を送らない',
    report: '修理に成功した日は insight_summary の先頭に「自己修理済み」と書く'
  }
};

const BRANDS = [
  {
    id: 'ci',
    name: 'クリスタルインセンス',
    engine: 'legacy',
    goal: '@crystal_insence のバズから売上をつくる（売上が立つのはCIアカウントのバズのみ）',
    kpi: 'フォロワー増と売上が主指標。❤は副指標。お香・国産のものづくりから外れたテーマは、❤が伸びても学習しない', // 既存の run-daily.sh の手順で処理中。新ループでは扱わない
    accounts: [
      { handle: 'crystal_insence', main: true,  thresholds: { buzz: 3000, ok: 800 } },
      { handle: 'gakikocamp',      main: false, thresholds: { buzz: 300,  ok: 80 } }
    ]
  },
  {
    id: 'startup-kyushu',
    name: 'スタートアップ九州',
    engine: 'multibrand',
    accounts: [{ handle: 'startupkyushu', main: true, thresholds: { buzz: 60, ok: 15 } }],
    goal: 'STARTUP KYUSHU 2026 の参加申し込み者を増やす',
    kpi: '❤（届く人数の代理指標）＋💬（問い合わせ・DMの代理指標）。申込につながる無料枠・締切の近い枠を優先して扱う',
    audience: '九州・福岡の起業家／起業を迷っている会社員／学生／事業会社・投資家',
    persona: '運営チームのカジュアルな語り口。一人称は使わないか「私たち」。絵文字は0〜1個',
    signature: 'STARTUP KYUSHU 2026｜10/8-9 福岡',
    research_tags: ['起業', 'スタートアップ', '福岡'],
    baseline: '実測(2026-09-10): 誤解を正す1行目「これ、バーベキューイベントじゃなくて」❤21／挙手「〜の方いますか？」❤18（ok）／変身願望＋講師権威 ❤8（miss）',
    phases: [
      { until: '2026-10-07', mode: 'recruit', note: '申込を増やす。締切の近い枠（朝食・テント宿泊 9/24、BBQ交流会 10/2）を優先' },
      { until: '2026-10-09', mode: 'live', note: '当日の空気を短文で。まだ間に合う無料枠（朝のランニング・ピラティス）を案内' },
      { until: '2026-12-31', mode: 'afterglow', note: '開催後の余韻と、来年に向けたフォローを促す' }
    ],
    facts: [
      'STARTUP KYUSHU 2026／主催：福岡市',
      '日程：2026年10月8日(木)〜9日(金)／会場：Artist Cafe Fukuoka・舞鶴公園BBQ GARDEN（福岡市中央区城内）',
      '集まる人：起業家、事業会社や投資家、学生、行政',
      '10/8 15:30〜17:30 じぶんをこねる粘土 アートワークショップ（Artist Cafe Fukuoka）参加無料・先着30名・要事前申込',
      '10/8 18:30〜19:30 メインセッション 参加無料・定員150名・要事前申込',
      '10/8 19:30〜21:00 BBQ交流会 一般5,500円（BBQ食材・2時間飲み放題）／学割2,200円（先着30名）・申込は10/2(金)23:59まで',
      '19:30以降の会場は交流会チケットを持っている人だけが入れる',
      '10/8 21:00〜22:00 KYUSHU 次世代ナイトピッチ（定員150名）：応募から選ばれた5組がエンジェル投資家の前で5分ピッチし、その場で公開フィードバック',
      '10/8 22:00〜 エンジェル投資家 Meet up（宿泊者・ナイトピッチ登壇者限定）',
      'キャンプ宿泊：テント・寝袋付き 一般6,600円／学割3,300円（先着20名・申込9/24(木)23:59まで）／道具持ち込み 無料',
      '10/9 7:30〜11:00 STARTUP MORNING RAVE（キャンプ女子プロデュース）',
      '10/9 7:30〜8:00 大濠公園ランニング 参加無料・参加自由／8:00〜9:00 朝のブレインピラティス 参加無料・参加自由',
      '10/9 9:30〜11:00 ブレスワーク瞑想・ジャーナリング講座 参加無料・先着30名・要事前申込',
      '10/9 朝食 1,500円（税込・要事前申込・9/24(木)23:59まで）',
      '申込URL：https://entrytickets.be/startup-kyushu/startupkyushu-2026（URLは追いリプにだけ書く）'
    ],
    ng: [
      'ナイトピッチ登壇エントリーの締切は書かない（資料間で日付が食い違っているため）',
      '19:30以降（BBQ交流会・ナイトピッチ）を無料と誤解させない',
      '行政の告知文のような硬い言い回し（「〜を開催いたします」「奮ってご参加ください」）'
    ]
  },
  {
    id: 'karen',
    name: '橋本華恋',
    engine: 'multibrand',
    accounts: [{ handle: 'konnichiwa.karen', main: true, thresholds: { buzz: 150, ok: 30 } }],
    goal: 'フォロワーを増やし、「日本の文化を発信する人」として知られるようにする',
    kpi: '❤（届く人数）と、フォロワー数の前日差。追いリプで「日本の話をこれからも書く」ことを示し、フォローの理由をつくる',
    audience: '日本の暮らし・食・季節・外遊びが好きな人／今のフォロワー（福岡で起業・副業したい人）',
    persona: '一人称「私」。やわらかい断言。絵文字は0〜1個。起業相談員の顔は残しつつ、話題の中心を日本の文化へ移していく',
    signature: '橋本華恋｜福岡から日本の文化を発信中',
    research_tags: ['日本文化', '暮らし', '起業'],
    baseline: '実測(2026-09-10): 読者への呼びかけ1行目「福岡で独立・起業を目指す皆様へ」❤308（固定・buzz）／告知や自分の話から入る投稿は❤12〜20（miss）→CIと同じく1行目が読者向けかどうかで16倍級の差',
    themes: ['日本の食と「いただきます」', '季節の行事と暦', '日本の外遊び・キャンプの作法', 'お香など日本の香り', '職人の仕事と、続けることの価値（起業の視点から）'],
    facts: [
      '1990年 熊本県出身／北九州市立大学卒業',
      '大手美容メーカーで営業職として7年勤務',
      '2018年 Instagramで女性向けキャンプコミュニティ「キャンジョ」を始め、3ヶ月でフォロワー1万人',
      '2019年 G\'s Academyの制作発表会GGAで優勝、同年キャンプ女子株式会社を設立（共同代表）',
      '文部科学省「アントレプレナーシップ推進大使」（2025年〜）',
      '初代 PR TIMES認定 プレスリリースエバンジェリスト',
      '福岡市 Fukuoka Growth Next スタートアップカフェ コンシェルジュ（起業相談員・2024年〜）',
      '会社のブランド：CRYSTAL INSENCE（国産のお香。共同代表の柴垣が香司）、WAGYU NINJA（日本の抹茶・和牛・工芸品を海外へ届ける）、VAN TRIP JAPAN',
      'STARTUP KYUSHU 2026 の10/9朝「STARTUP MORNING RAVE」をキャンプ女子がプロデュース'
    ],
    ng: [
      '茶道・香道・着物などの資格や修行歴を創作しない（本人は香司ではない。香司は柴垣）',
      '「〜で何度も見てきた」「〜と言われた」など、事実表にない体験談を作らない',
      '肩書きを並べて自慢に見える書き方',
      '共同代表の実名を本文に出さない（追いリプで「うちの会社の香司」までは可）'
    ]
  },
  {
    id: 'vantrip',
    name: 'VAN TRIP JAPAN',
    engine: 'multibrand',
    accounts: [{ handle: 'vantripjapan', main: true, thresholds: { buzz: 10, ok: 3 } }],
    goal: '福岡に旅行に来たい海外の人に、VANの長期レンタルで九州を旅してもらう（予約を増やす）。ただし2026-09-18時点でフォロワー0人のため、当面の最優先はフォロワーと露出の獲得',
    judgment_hold: 'フォロワーが50人未満の間は、❤0を文面の失敗として判定しない（配信そのものが起きていないため）。results には記録するが、insight_summary では「リーチ不足」と明記し、勝ち型・負け型の結論を出さない',
    growth_first: ['CI・橋本華恋・VAN TRIP JAPANのInstagramから導線を作る', '日本旅行の話題に返信して露出を作る', '固定投稿を1本用意する'],
    kpi: '❤とリプ（質問）。国別・言語別・2行目の角度別に反応を記録し、配分を決める',
    audience: '福岡・九州への旅行を考えている海外の人。予約実績(2026-07〜08・15件): カナダ3、シンガポール3、イスラエル2、ポーランド2、スイス・ドイツ・フランス・オーストラリア・マレーシア各1。申込言語は英語12・独1・仏1・ヘブライ1',
    languages: { en: '主軸', fr: 'フランス向け', de: 'ドイツ・スイス向け', he: '保留（予約1件・ガイド登録0件。母語話者の確認なしに出さない）' },
    persona: '家族経営の親しみ。1行目は国名＋国旗で「福岡に来る？」と直接呼びかける（挙手型）。2行目で「街だけで終わらせず、VANで1〜2週間九州を回る」絵を見せる。仏語は vous、独語は ihr',
    signature: '',
    baseline: '実測開始時点(2026-09-12): フォロワー0人。直近3投稿は反応表示なし。まず国名・言語・旅の日数・2行目の角度ごとに小さな反応差を記録する',
    equation_override: '英語・仏語・独語は4〜6行・本文240文字以内。依頼は「❤️だけ」。ブランド名の署名は付けない。料金・受け渡し・URLは追いリプ。候補には日本語訳を rationale に付ける',
    facts: [
      '出典: vantripjapan.jp の実表示（2026-09-11確認）。VanTripJapan/llms-full.txt の料金・定員は古いので使わない',
      'Family-run (Karen & her husband) in Fukuoka since 2022. Hand-built campervans',
      '10 min from Fukuoka Airport. Self check-in: keys from a lockbox, pick up anytime, even if the flight lands at midnight',
      'All-inclusive from ¥22,000/day (Toyota Probox, Mazda Bongo Brawny) / from ¥25,000/day (Daihatsu Pocket Loft). Insurance (CDW), cooking gear, ETC card and 24/7 support included',
      'Longer stays = better value per day（割引率は投稿に書かない）',
      'Toyota Probox: sleeps 2 (roof tent) / Mazda Bongo Brawny: 2-3 guests, built-in bed / Daihatsu Pocket Loft: 2-4 guests, island ferry friendly (Yakushima, Goto Islands). All automatic',
      'One-way drops: Fukuoka to Tokyo, Osaka, Kyoto (surcharge applies)',
      'Rated 5.0 on Google Maps',
      'Road trip planner: 3 to 5 days (Aso and Beppu loop) / 6 to 8 days the classic route (volcano hikes, Takachiho Gorge rowing, coastal driving) / 9+ days all of Kyushu incl. Nagasaki and Kagoshima. https://vantripjapan.jp/road-trip-planner/',
      'Kyushu highlights on the site: Beppu hot springs, Kurokawa, the Aso caldera rim, Takachiho Gorge, Kuju trails, Nichinan coast, waking up to ocean views',
      'Booking: https://vantripjapan.jp/rent',
      'Japan drives on the left (same as Singapore, Malaysia, Australia)',
      '（追いリプの補足用）免許: 独・スイス・仏・ベルギー・モナコ・台湾の国際免許は日本で無効でJAF翻訳が必要（JDLTC €99〜）。米英豪は国際免許で可。イスラエルは紙の冊子のみ有効'
    ],
    ng: [
      '免許の警告を主役にしない（目的は長期レンタルの九州旅。免許は追いリプの補足まで）',
      '国ごとの免許の可否は facts にある国だけ（カナダ・シンガポール・マレーシア・ポーランドは未確認）',
      '割引率（％OFF）を投稿に書かない',
      '口コミの引用や人名（レビューの帰属を確認できないため）',
      '「世界最大」「日本一」など最上級の観光表現',
      'ヘブライ語の本文は母語話者の確認なしに出さない'
    ]
  }
];

export async function onRequestGet({ request }) {
  if (request.headers.get('x-sync-key') !== SYNC_KEY) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  const id = new URL(request.url).searchParams.get('id');
  const brands = id ? BRANDS.filter(b => b.id === id) : BRANDS;
  return Response.json({ ok: true, updated: UPDATED, equation: EQUATION, success: SUCCESS, common_ng: COMMON_NG, recalibrate: RECALIBRATE, collection: COLLECTION, brands });
}
