import path from 'path';
import { defineConfig } from 'vite';
import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

const rawPort = process.env.PORT;
if (!rawPort) throw new Error('PORT environment variable is required but was not provided.');
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

const basePath = process.env.BASE_PATH;
if (!basePath) throw new Error('BASE_PATH environment variable is required but was not provided.');

export default defineConfig({
  base: basePath,
  plugins: [
    runtimeErrorOverlay(),
    // cartographer and devBanner omitted — they inject Tailwind browser + scripts
    // that interfere with the app's own CSS in the Replit proxy environment.
  ],
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
