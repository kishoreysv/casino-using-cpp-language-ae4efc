/** Launch compiled backend and Vite preview independently for real HTTP session journeys. */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } }
  ],
  webServer: [
    {
      command: 'node dist/index.js',
      cwd: '../backend',
      url: 'http://127.0.0.1:3100/api/health',
      env: { PORT: '3100', NODE_ENV: 'test', DATABASE_URL: 'sqlite:./data/e2e-session.db', CORS_ORIGIN: 'http://127.0.0.1:4173' },
      reuseExistingServer: false
    },
    {
      command: 'node node_modules/vite/bin/vite.js preview',
      url: 'http://127.0.0.1:4173',
      env: { PREVIEW_PORT: '4173', API_PROXY_TARGET: 'http://127.0.0.1:3100' },
      reuseExistingServer: false
    }
  ]
});
