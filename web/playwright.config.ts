import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testIgnore: '**/._*',
  timeout: 90000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.FSAPP_BASE_URL || 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    acceptDownloads: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: process.env.FSAPP_CHROMIUM_EXECUTABLE ? { executablePath: process.env.FSAPP_CHROMIUM_EXECUTABLE } : undefined } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: process.env.FSAPP_BASE_URL ? undefined : {
    command: '../scripts/run-server.sh',
    // The suite creates many short-lived sessions on one loopback address.
    // Test-only claim budgets allow the suite to repeatedly pair on one loopback IP.
    env: { FSAPP_CREATE_PER_MINUTE: '1000', FSAPP_REQUEST_PER_MINUTE: '10000', FSAPP_PAIRING_ATTEMPTS_PER_MINUTE: '1000', FSAPP_PAIRING_GLOBAL_ATTEMPTS_PER_MINUTE: '1000' },
    url: 'http://127.0.0.1:8080/actuator/health',
    reuseExistingServer: !process.env.CI,
    timeout: 90000,
  },
});
