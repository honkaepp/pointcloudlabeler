import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// The application's version, for the files it writes about itself —
// the Compare view's export sidecar names the version that rendered
// the figure. One source: package.json, which tauri.conf.json's
// version is kept equal to.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

// The commit the build came from, for the same files. A figure's sidecar
// records it so a published figure can be traced to the code that
// made it — which is the thing a reviewer cannot check today. Empty
// outside a git checkout; never a build failure.
function gitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

// Tauri dev server. The renderer is loaded into a WebView2 / WebKit window
// driven by src-tauri/.
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_COMMIT__: JSON.stringify(gitCommit()),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Tauri expects a fixed port for HMR and to load the dev server URL.
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    // The webviews bundle modern V8/JavaScriptCore; no need for legacy
    // transpiles. The three.js bundle is naturally large so raise the
    // warning threshold.
    target: 'esnext',
    chunkSizeWarningLimit: 2048,
  },
});
