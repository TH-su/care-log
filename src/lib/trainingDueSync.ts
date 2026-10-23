// デイ（せせらぎ）段階3c: 計画書の期限を写す手順（2026-10-23 追加・代表承認・段階3の計画 4章）。
// 1. 役割を確かめる（事務所・管理者だけ）。現場のログインでは、計画書アプリの接続先を読まず、計画書の GAS へも送らない
//    （索引には全員の氏名が入っているため、読む前に止める＝名簿の同期と同じ作法）
// 2. 計画書アプリの索引を読む（trainingPlanClient.ts・読むだけ・写す分だけにそろえる）
// 3. 0046 の写しの関数を1回呼ぶ（db.ts の syncTrainingDue・写した職員はいまの記録者）
// 開いた時には呼ばない（〔計画書の期限を写す〕を押した時だけ＝表示で書かない）。

import { canWriteMasters, fetchAllResidents, fetchMyRole, syncTrainingDue } from './db'
import { TRAINING_DUE_EMPTY_INDEX_TEXT, countMatchable, fetchTrainingPlanIndex, trainingDueNoMatchText, trainingPlanFailText } from './trainingPlanClient'
import type { TrainingDueSyncResult } from './trainingPlanClient'

export type TrainingPlanSyncOutcome =
  | { kind: 'role' }
  | { kind: 'fail'; text: string }
  | { kind: 'done'; result: TrainingDueSyncResult }

/** 写しの手順（失敗は { kind:'fail' }。DB の拒否・通信の失敗は DbError を投げる＝画面がそのまま文を出す） */
export async function syncTrainingPlanDue(actorId: number | null): Promise<TrainingPlanSyncOutcome> {
  // 役割を先に確かめる（分からない時も写さない側に倒す）
  if (!canWriteMasters(await fetchMyRole())) return { kind: 'role' }
  if (actorId === null) return { kind: 'fail', text: '記録者が選ばれていません。上の「記録者」で選んでから押してください。' }
  const idx = await fetchTrainingPlanIndex()
  if (!idx.ok) return { kind: 'fail', text: trainingPlanFailText(idx.reason) }
  // 写せる行が1つも無い索引は送らない（写しが空の初回は関数の守りが働かず、設定の行だけを書くため＝確認の反証 軽1。
  // 写しが既にある時も関数が empty で拒むので、条件を付けずに止めてよい）
  if (idx.rows.length === 0) return { kind: 'fail', text: TRAINING_DUE_EMPTY_INDEX_TEXT }
  // 送る前に care-log の利用者番号と突き合わせる。1人も結べなければ写しの関数を呼ばない
  // （写しが空の初回は関数の「結べる番号が0件」の守りが働かず、設定の行だけを書いてしまう＝段階3c の反証 中1）
  let sourceIds: Set<string>
  try {
    sourceIds = new Set((await fetchAllResidents()).map((r) => r.source_id))
  } catch {
    return { kind: 'fail', text: 'care-log の利用者の名簿を読めなかったため、写しませんでした。通信状態を確かめて、もう一度押してください。' }
  }
  if (countMatchable(idx.rows, sourceIds) === 0) return { kind: 'fail', text: trainingDueNoMatchText(idx.rows.length) }
  return { kind: 'done', result: await syncTrainingDue(idx.rows, idx.settings, actorId) }
}
