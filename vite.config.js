import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const appVersion = process.env.npm_package_version || '0.0.0';
  const buildTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:]/g, '-');
  const buildLabel = env.VITE_APP_BUILD_LABEL || `v${appVersion} ${buildTimestamp}`;

  return {
    logLevel: 'error', // Suppress warnings, only show errors
    define: {
      'import.meta.env.VITE_APP_BUILD_LABEL': JSON.stringify(buildLabel),
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
    },
    resolve: {
      alias: {
        '@': path.resolve(process.cwd(), 'src'),
      },
    },
    plugins: [react()]
  };
});
