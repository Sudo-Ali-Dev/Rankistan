import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Root-absolute: tabs are served at their own paths (/map, /badge, ...) and campaign
  // landings at /from/..., so a relative ./assets would resolve under them.
  base: '/',
})
