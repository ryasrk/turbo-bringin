import { defineConfig, loadEnv } from 'vite'

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
    build: {
      // Enable CSS minification (esbuild is default, already good)
      cssMinify: true,
      // Target modern browsers for smaller output
      target: 'es2022',
      // Manual chunk splitting for better caching
      rollupOptions: {
        output: {
          manualChunks: {
            // Agent Room feature — loaded only when entering agent rooms
            'agent-room': [
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
            // Room system — loaded when navigating to rooms
            'rooms': [
              './src/roomsUI.js',
              './src/roomsList.js',
              './src/roomChat.js',
              './src/roomsUtils.js',
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
