import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { copyFileSync, mkdirSync } from 'fs'

function copyPdfjsWorker() {
  return {
    name: 'copy-pdfjs-worker',
    buildStart() {
      try {
        mkdirSync('public', { recursive: true })
        copyFileSync(
          resolve('node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),
          resolve('public/pdf.worker.min.mjs')
        )
        console.log('pdf.worker.min.mjs copiado para public/')
      } catch (e) {
        console.warn('Nao foi possivel copiar pdf.worker:', e)
      }
    }
  }
}

export default defineConfig({
  plugins: [react(), copyPdfjsWorker()],
  server: {
    host: true,
    port: 3000,
    strictPort: false,
    // Permite servir atrás do proxy de preview (dev apenas; não afeta o build).
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'esbuild',
  }
})
