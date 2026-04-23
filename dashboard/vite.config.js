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
  }
})
