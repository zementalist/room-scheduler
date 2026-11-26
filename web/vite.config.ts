import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

// VITE_BACKEND=static builds the GitHub Pages edition: relative asset paths (the site lives under /<repo>/)
// and the committed data file is published next to index.html as data.json.
const isStatic = process.env.VITE_BACKEND === 'static';

export default defineConfig({
  root,
  base: isStatic ? './' : '/',
  publicDir: isStatic ? fileURLToPath(new URL('../schedule', import.meta.url)) : false,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
