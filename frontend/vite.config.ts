import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` (development, production)
  // and expose them as plain strings
  const env = loadEnv(mode, process.cwd(), '');

  // Vite env vars are strings; fallback to localhost:3000 if not provided
  const backendUrl = (env.VITE_API_URL && env.VITE_API_URL !== '') ? env.VITE_API_URL : 'http://localhost:3000';

  return {
    plugins: [
      react({
        // Emotion / fast-refresh options can be added here if needed
      })
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src')
      }
    },
    server: {
      // Dev server proxy so frontend can call /api/* locally without CORS problems
      proxy: {
        // Proxy all /api requests to your backend (adjust path if needed)
        '^/api': {
          target: backendUrl,
          changeOrigin: true,
          secure: false,
          // keep the /api path intact (no rewrite)
        }
      },
      // Optional: pick a fixed port for local dev
      port: 5173,
      strictPort: false
    },
    build: {
      outDir: 'dist',
      sourcemap: mode === 'development'
    },
    define: {
      // expose any runtime envs you want to inline (useful fallbacks)
      __BACKEND_URL__: JSON.stringify(backendUrl)
    }
  };
});
