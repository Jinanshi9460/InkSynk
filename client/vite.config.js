import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_SERVER_URL is read at BUILD time (Vite inlines it into the bundle), so it must be set in
// the hosting dashboard before the production build runs. If it is missing the client falls back
// to the page's own origin (see src/hooks/useSocket.js); it never falls back to localhost in a
// production build.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (mode === 'production') {
    const url = env.VITE_SERVER_URL;
    if (!url) {
      console.warn('\n[warn] VITE_SERVER_URL is not set: the built client will connect to its own origin.\n');
    } else if (/localhost|127\.0\.0\.1/.test(url)) {
      console.warn(`\n[warn] VITE_SERVER_URL is "${url}": this build only works on your own machine. Set it to your deployed server URL for production.\n`);
    }
  }
  return {
    plugins: [react()],
    server: { port: 5173 },
  };
});
