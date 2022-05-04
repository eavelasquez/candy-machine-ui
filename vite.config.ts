import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    // generate manifest.json in output directory
    // https://vitejs.dev/config/#manifest
    manifest: true,
  },
  plugins: [react()]
})
