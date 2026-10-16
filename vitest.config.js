import { defineConfig } from 'vitest/config';

// The tests must also run without a .env (on GitHub, see .github/workflows/release.yml).
// A made-up secret, so the webhook tests can sign their test messages; real secrets are never needed.
export default defineConfig({
    test: {
        env: { SHOPIFY_CLIENT_SECRET: 'test-only-webhook-secret' },
    },
});
