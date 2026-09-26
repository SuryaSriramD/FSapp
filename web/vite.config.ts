import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': { target: 'http://127.0.0.1:8080', ws: true },
      '/actuator': { target: 'http://127.0.0.1:8080' },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/._*'],
    testTimeout: 15000,
  },
});
