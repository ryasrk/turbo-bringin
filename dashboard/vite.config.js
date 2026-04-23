import { defineConfig, loadEnv } from 'vite'
import { compression } from 'vite-plugin-compression2'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const dashboardPort = env.DASHBOARD_PORT || process.env.DASHBOARD_PORT || '3000'
  const controlPort = env.CONTROL_PORT || process.env.CONTROL_PORT || '3002'

  // Build allowedHosts from NGROK_DOMAIN if set (supports ngrok tunneling)
  const ngrokDomain = env.NGROK_DOMAIN || process.env.NGROK_DOMAIN || ''
  const allowedHosts = ngrokDomain ? [ngrokDomain] : []

  return {
    envDir: '..',
    server: {
      port: Number(dashboardPort),
      allowedHosts,
      proxy: {
        '/v1': {
          target: `http://localhost:${controlPort}`,
          changeOrigin: true,
        },
        '/health': {
          target: `http://localhost:${controlPort}`,
          changeOrigin: true,
        },
        '/manager': {
          target: `http://localhost:${controlPort}`,
          changeOrigin: true,
          ws: true,
          rewrite: (path) => path.replace(/^\/manager/, ''),
        },
        '/api': {
          target: `http://localhost:${controlPort}`,
          changeOrigin: true,
        },
      },
    },
    plugins: [
      // Pre-compress static assets at build time (Brotli level 11 — max compression)
      compression({ algorithm: 'brotliCompress', exclude: [/\.(png|jpg|jpeg|gif|webp|avif)$/i] }),
      // Also generate gzip for clients that don't support Brotli
      compression({ algorithm: 'gzip', exclude: [/\.(png|jpg|jpeg|gif|webp|avif)$/i] }),
    ],
    build: {
      // Enable CSS minification (esbuild is default, already good)
      cssMinify: true,
      // Target modern browsers for smaller output
      target: 'es2022',
      // Manual chunk splitting for better caching
      rollupOptions: {
        output: {
          manualChunks: {
            // Rooms + Agent Room feature (merged — tightly coupled via cross-imports)
            'rooms': [
              './src/roomsUI.js',
              './src/roomsList.js',
              './src/roomChat.js',
              './src/roomsUtils.js',
              './src/agentSocket.js',
              './src/agentWorkspace.js',
              './src/agentWorkspaceData.js',
              './src/agentWorkspacePreview.js',
              './src/agentConfigModal.js',
              './src/agentHandoffViz.js',
              './src/agentTokenUsage.js',
              './src/agentOrchestrationConfig.js',
              './src/agentTypingIndicator.js',
              './src/agentMemoryPanel.js',
            ],
            // Auth + API client — core but separable
            'auth': [
              './src/authClient.js',
              './src/authUI.js',
            ],
            // Chat features — main chat functionality
            'chat': [
              './src/chatApi.js',
              './src/chatStorage.js',
              './src/conversationManager.js',
              './src/messageRenderer.js',
              './src/markdownRenderer.js',
              './src/searchManager.js',
            ],
          },
        },
      },
    },
  }
})
