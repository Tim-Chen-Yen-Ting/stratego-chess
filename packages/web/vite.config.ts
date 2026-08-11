import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * In dev, Vite serves the client on 5173 and proxies everything the Fastify
 * server owns to localhost:3000. In production there is no proxy at all: the
 * server serves this build from the same origin (techspec §8).
 */
const SERVER_ORIGIN = 'http://localhost:3000'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: SERVER_ORIGIN, changeOrigin: true },
      '/llm': { target: SERVER_ORIGIN, changeOrigin: true },
      '/socket.io': { target: SERVER_ORIGIN, changeOrigin: true, ws: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: SERVER_ORIGIN, changeOrigin: true },
      '/llm': { target: SERVER_ORIGIN, changeOrigin: true },
      '/socket.io': { target: SERVER_ORIGIN, changeOrigin: true, ws: true },
    },
  },
})
