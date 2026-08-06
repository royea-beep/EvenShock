import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // Served from https://ftable.co.il/evenshock/ — a subdirectory, not the domain
  // root. Without this, built asset URLs are absolute (/assets/...) and 404 in
  // production. Must match the deploy's remote path (CPANEL_FTP_REMOTE_PATH).
  base: '/evenshock/',
  plugins: [react(), tailwindcss()],
  build: {
    // Never inline theme artwork. Vite base64-inlines assets under 4KB, which
    // would bake the picker thumbnails into the main JS bundle — making
    // `loading="lazy"` a no-op and charging every visitor for all seven themes'
    // previews up front. As separate files they stay cacheable and deferrable.
    assetsInlineLimit: (filePath) => (filePath.endsWith('.webp') ? false : undefined),
  },
})
