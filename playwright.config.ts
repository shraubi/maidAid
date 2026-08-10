import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: { baseURL: "http://127.0.0.1:4273", trace: "retain-on-failure" },
  projects: [
    { name: "mobile", use: { baseURL: "http://127.0.0.1:4273", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: "desktop", use: { baseURL: "http://127.0.0.1:4275", viewport: { width: 1280, height: 900 } } },
  ],
});
