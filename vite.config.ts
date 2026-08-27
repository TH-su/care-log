import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' → GitHub Pages のサブパス配信でも相対パスで動作する
export default defineConfig({
  plugins: [react()],
  base: './',
})
