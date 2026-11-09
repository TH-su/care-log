// デイのバイタル・食事の画面の道（2026-11-09 計画B3・代表者の指示「バイタル一括と食事一括画面は…一つの画面に統合せよ」）。
// App の道の振り分け（古い2つの道からの送り）からも読む小さな部品（依存なし・副作用なし）。tests/daycare-vitals-meals.test.mjs から node で直接読む

/** バイタル・食事の画面のルート */
export const DAYCARE_VITALS_MEALS_PATH = '/record/daycare/vitals-meals'

/** それまでのバイタル一括・食事一括の道（今はバイタル・食事の画面へ送る） */
export const DAYCARE_OLD_BULK_PATHS: readonly string[] = ['/record/daycare/vitals', '/record/daycare/meals']

/** バイタル・食事の画面のルート（業務日は ?day= で持つ。今日は付けない） */
export function vitalsMealsPath(day: string, today: string): string {
  return `${DAYCARE_VITALS_MEALS_PATH}${day === today ? '' : `?day=${day}`}`
}

/**
 * 古い2つの道から、バイタル・食事の画面への送り先。業務日（?day=）だけを引き継ぐ（形の検査は送り先の画面の readPersonDay がする）。
 * search は location.search（先頭の ? はあってもなくてもよい）
 */
export function vitalsMealsRedirect(search: string): string {
  const day = new URLSearchParams(search).get('day')
  return day === null || day === '' ? DAYCARE_VITALS_MEALS_PATH : `${DAYCARE_VITALS_MEALS_PATH}?day=${encodeURIComponent(day)}`
}
