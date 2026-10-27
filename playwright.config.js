import { defineConfig } from "@playwright/test";

export default defineConfig({ testDir: "./browser-test", workers: 1, timeout: 45000, reporter: "list" });
