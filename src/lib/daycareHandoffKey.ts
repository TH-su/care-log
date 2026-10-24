// デイから排泄ケアアプリへの受け渡しのキーの名前と、消す関数だけ（App のログアウトの後片付けから読む小さな部品・依存なし）。
// 中身を作る・書くのは daycareHandoff.ts（§9.7）

/** 受け渡しのキー（排泄ケアアプリの DC_HANDOFF_KEY と同じ） */
export const DAYCARE_HANDOFF_KEY = 'su_daycare_handoff_v1'

/** 受け渡しのキーを消す（ログアウトの時だけ。記録者の切り替えでは消さない＝反証 軽3） */
export function clearDaycareHandoff(): void {
  try {
    window.localStorage.removeItem(DAYCARE_HANDOFF_KEY)
  } catch {
    // 消せなくても続ける
  }
}
