import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const inferencePort = env.INFERENCE_PORT || process.env.INFERENCE_PORT || '18080'
  const controlPort = env.CONTROL_PORT || process.env.CONTROL_PORT || '3002'

  return {
    server: {
      port: 3000,
      proxy: {
        '/v1': {
          target: `http://localhost:${inferencePort}`,
          changeOrigin: true,
        },
        '/health': {
          target: `http://localhost:${inferencePort}`,
          changeOrigin: true,
        },
        '/manager': {
          target: `http://localhost:${controlPort}`,
          changeOrigin: true,
          ws: true,
          rewrite: (path) => path.replace(/^\/manager/, ''),
        },
      },
    },
  }
})
