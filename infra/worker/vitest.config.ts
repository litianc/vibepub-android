import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    miniflare: {
      serviceBindings: {
        WRITING_AGENT: async (request: Request) => {
          if (request.headers.get("authorization") !== "Bearer test-writing-token") return new Response(JSON.stringify({ error: { code: "unauthorized", retryable: false } }), { status: 401 });
          return Response.json({ protocol_version: "vibepub.editorial.v3", result: { synthetic: true } });
        },
        REVIEW_AGENT: async (request: Request) => {
          if (request.headers.get("authorization") !== "Bearer test-review-token") return new Response(JSON.stringify({ error: { code: "unauthorized", retryable: false } }), { status: 401 });
          return Response.json({ protocol_version: "vibepub.editorial.review.v1", result: { synthetic: true } });
        },
      },
    },
    wrangler: { configPath: "./wrangler.toml" },
  })],
  test: {
    include: ["test/**/*.runtime.test.ts"],
  },
});
