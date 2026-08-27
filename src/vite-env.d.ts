/// <reference types="vite/client" />

// Vite 標準の型参照ファイル。src/lib/supabase.ts（凍結ファイル）が import.meta.env を
// 直接読むため、これが無いと `tsc -b` が TS2339（Property 'env' does not exist on type
// 'ImportMeta'）で落ちる。tsconfig.app.json（凍結）に types を足す代わりにここで解決する。
