import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Hosts allowed to reach the dev/preview servers. Vite rejects any request whose
// Host header is not listed here with HTTP 403, which is exactly what a platform
// healthcheck (Railway probes `healthcheck.railway.app`) runs into.
// A leading dot matches every subdomain, e.g. '.up.railway.app'.
const ALLOWED_HOSTS = ['healthcheck.railway.app', '.up.railway.app'];

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', port: 3000, strictPort: false, allowedHosts: ALLOWED_HOSTS },
  preview: { host: '0.0.0.0', port: 3000, allowedHosts: ALLOWED_HOSTS },
});
