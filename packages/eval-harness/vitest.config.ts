import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/helpers/register-fake-driver.ts"],
    retry: 0,
  },
})
