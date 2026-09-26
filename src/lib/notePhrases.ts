// 申し送りフォームの「定型句」（場面ごとの文ボタン）の一覧と、本文への差し込みの純関数。
//
// - 文言は叩き台で、後日差し替える前提。一覧はこのファイルだけに置く（画面側に写しを持たない）
// - 「＿」（全角 U+FF3F）は差し込んだ後に書き足す所。差し込み直後はここを選択状態にする
// - 通信・DOM・React に触れない（tests/ から直接読み込んで確かめる）
// - 実名・病名・記録本文由来の文字列を書かない（敬称「様」「さん」も入れない＝テストで検査）

export interface NotePhraseCategory {
  /** 場面の id。最後に選んだ場面として localStorage に残すのはこの値だけ */
  readonly id: string
  readonly label: string
  readonly phrases: readonly string[]
}

export const NOTE_PHRASE_CATEGORIES: readonly NotePhraseCategory[] = [
  {
    id: 'body',
    label: '体調・バイタル',
    phrases: [
      'バイタル著変なし',
      '体温＿℃、クーリング実施',
      'SpO2＿％、再検予定',
      '血圧高め（＿/＿）、再検予定',
      '倦怠感の訴えあり、経過観察',
    ],
  },
  {
    id: 'meal',
    label: '食事・水分',
    phrases: [
      '食事全量摂取',
      '朝食 主食＿割・副食＿割',
      '食欲低下あり、声かけ継続',
      '水分摂取少なめ、こまめに声かけを',
      '食事中ムセ込みあり',
    ],
  },
  {
    id: 'excretion',
    label: '排泄',
    phrases: [
      '排便あり（普通便）',
      '排便なし＿日目',
      '下剤＿錠 服用',
      '尿失禁あり、更衣実施',
      'トイレ誘導の拒否あり',
    ],
  },
  {
    id: 'night',
    label: '睡眠・夜間',
    phrases: [
      '夜間良眠',
      '巡視時 異常なし',
      '不眠あり、＿時頃まで覚醒',
      '夜間トイレ＿回',
      'ナースコール頻回',
    ],
  },
  {
    id: 'skin',
    label: '皮膚',
    phrases: [
      '発赤あり（部位＿）、経過観察',
      '表皮剥離あり（部位＿）、処置実施',
      '内出血あり（部位＿）',
      '軟膏塗布実施',
    ],
  },
  {
    id: 'fall',
    label: '転倒・事故',
    phrases: [
      '転倒あり、外傷なし、バイタル著変なし',
      'ベッドからずり落ちあり、外傷なし',
      '看護師へ報告済み',
      'ご家族へ報告済み',
      '事故報告書を作成予定',
    ],
  },
  {
    id: 'medical',
    label: '受診・医療',
    phrases: [
      '＿受診、処方変更なし',
      '処方変更あり（内容：＿）',
      '訪問診療あり、指示なし',
      '次回受診 ＿月＿日',
      '入院となる（＿病院）',
    ],
  },
  {
    id: 'meds',
    label: '服薬',
    phrases: [
      '服薬拒否あり、再度の声かけで服用',
      '頓服（＿）使用',
      '薬の飲み残しあり',
      '残薬 確認済み',
    ],
  },
  {
    id: 'family',
    label: '家族・外出',
    phrases: [
      'ご家族面会あり',
      'ご家族より電話あり（＿について）',
      '外出（＿時〜＿時）',
      '外泊（〜＿日）',
    ],
  },
  {
    id: 'notice',
    label: '業務連絡',
    phrases: [
      '引き続き様子観察をお願いします',
      '確認済み',
      '＿の補充をお願いします',
      '本日の予定：＿',
    ],
  },
]

/** 書き足す所の印（全角の低線 U+FF3F） */
export const PHRASE_BLANK = '＿'

/**
 * 本文の末尾に定型句を差し込む（純関数）。
 * - 本文が空でなく、末尾1文字が「。」でも改行でもなければ「。」を補ってからつなぐ
 * - 差し込んだ文の中に「＿」があれば、最初の「＿」1文字を選択範囲として返す（そのまま打てば置き換わる）。
 *   無ければ選択範囲は新しい本文の末尾（カーソルを最後に置く）
 * - 位置は textarea の setSelectionRange と同じ単位（UTF-16 の文字位置）
 */
export function appendPhrase(
  body: string,
  phrase: string,
): { body: string; selStart: number; selEnd: number } {
  const last = body.slice(-1)
  const needsStop = body !== '' && last !== '。' && last !== '\n' && last !== '\r'
  const head = needsStop ? `${body}。` : body
  const next = head + phrase
  const blank = next.indexOf(PHRASE_BLANK, head.length)
  if (blank >= 0) return { body: next, selStart: blank, selEnd: blank + 1 }
  return { body: next, selStart: next.length, selEnd: next.length }
}
