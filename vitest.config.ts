import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config.
 *
 * The repo had no config file, so the `@/` path alias from tsconfig did NOT resolve at
 * runtime in tests — every existing test file works around it with relative imports (the
 * one `@/` import, in `src/lib/draftkings/match.test.ts`, is `import type` and so is erased
 * before it ever runs). Wiring the alias here removes that trap.
 *
 * This does NOT change the rule that testable logic belongs in PURE modules: there is no DB
 * mocking anywhere in this repo, so a test that reaches `@/db` will try to open a real Neon
 * connection. Keep engine logic free of I/O and test that.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
