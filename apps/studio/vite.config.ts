import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5273,
    strictPort: true,
    allowedHosts: true, // Allow all hosts for maximum compatibility with ALBs and cloud deployments
    proxy: {
      // Proxy all /api and /health requests to backend
      // Launchpad platform API (unified deployer) — Launchpad-specific addition
      '/launchpad-api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/launchpad-api/, '/api')
      },
      '/api': {
        target: 'http://localhost:8100',
        changeOrigin: true,
        secure: false
      },
      '/health': {
        target: 'http://localhost:8100',
        changeOrigin: true,
        secure: false
      },
      // Proxy WebSocket connections for real-time updates
      '/ws': {
        target: 'ws://localhost:8100',
        ws: true,
        changeOrigin: true
      }
    }
  },
  server: {
    host: '0.0.0.0',
    port: 5273,
    strictPort: true,
    proxy: {
      // Same proxy configuration for development server
      // Launchpad platform API (unified deployer) — Launchpad-specific addition
      '/launchpad-api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/launchpad-api/, '/api')
      },
      '/api': {
        target: 'http://localhost:8100',
        changeOrigin: true,
        secure: false
      },
      '/health': {
        target: 'http://localhost:8100',
        changeOrigin: true,
        secure: false
      },
      '/ws': {
        target: 'ws://localhost:8100',
        ws: true,
        changeOrigin: true
      }
    }
  }
})
