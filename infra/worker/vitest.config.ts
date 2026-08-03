import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const value = new Uint8Array(12 + data.byteLength);
  const view = new DataView(value.buffer);
  view.setUint32(0, data.byteLength);
  value.set(typeBytes, 4);
  value.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(value.slice(4, 8 + data.byteLength)));
  return value;
}

async function syntheticPng(width: number, height: number): Promise<string> {
  const rowLength = width * 4 + 1;
  const raw = new Uint8Array(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * rowLength] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * rowLength + 1 + x * 4;
      const black = x === 0 && y === 0;
      raw[offset] = black ? 0 : 255;
      raw[offset + 1] = black ? 0 : 255;
      raw[offset + 2] = black ? 0 : 255;
      raw[offset + 3] = 255;
    }
  }
  const compressed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const end = chunk("IEND", new Uint8Array());
  const output = new Uint8Array(signature.byteLength + chunk("IHDR", ihdr).byteLength + chunk("IDAT", compressed).byteLength + end.byteLength);
  let offset = 0;
  for (const part of [signature, chunk("IHDR", ihdr), chunk("IDAT", compressed), end]) { output.set(part, offset); offset += part.byteLength; }
  let binary = "";
  for (let offset = 0; offset < output.byteLength; offset += 0x8000) binary += String.fromCharCode(...output.slice(offset, Math.min(offset + 0x8000, output.byteLength)));
  return btoa(binary);
}

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
        IMAGE_GENERATION_ADAPTER: async (request: Request) => {
          if (request.headers.get("authorization") !== "Bearer test-visual-token") return new Response(JSON.stringify({ error: { code: "unauthorized", retryable: false } }), { status: 401 });
          let body: Record<string, unknown>;
          try { body = await request.json() as Record<string, unknown>; } catch { return Response.json({ error: { code: "invalid_json", retryable: false } }, { status: 400 }); }
          const operation = request.url.endsWith("/internal/v3/visual/plan") ? "plan" : "image";
          return Response.json({
            protocol_version: "vibepub.visual.v3",
            operation,
            operation_id: typeof body.operation_id === "string" ? body.operation_id : "synthetic-operation",
            attempt: typeof body.attempt === "number" ? body.attempt : 1,
            result: operation === "plan"
              ? { adapter_version: "visual-generation.adapter.1.0.0", model_version: "gpt-image-2", prompt_hash: await sha256(JSON.stringify((body.plan as Record<string, unknown>)?.slots ? ((body.plan as Record<string, unknown>).slots as Array<Record<string, unknown>>).map(slot => slot.prompt_hash) : [])) }
              : { adapter_version: "visual-generation.adapter.1.0.0", model_version: "gpt-image-2", prompt_hash: await sha256(String(body.prompt || "")), b64_json: await syntheticPng(...(typeof body.size === "string" && /^\d+x\d+$/.test(body.size) ? body.size.split("x").map(Number) as [number, number] : [1536, 864])) },
          });
        },
        WECHAT_PUBLISHING_ADAPTER: async (request: Request) => {
          if (request.headers.get("authorization") !== "Bearer test-wechat-token") return Response.json({ error: { code: "unauthorized", retryable: false } }, { status: 401 });
          let body: Record<string, unknown>;
          try { body = await request.json() as Record<string, unknown>; } catch { return Response.json({ error: { code: "invalid_json", retryable: false } }, { status: 400 }); }
          const operation = typeof body.operation === "string" ? body.operation : "";
          const operationId = typeof body.operation_id === "string" ? body.operation_id : "synthetic-wechat-operation";
          if (operation === "resolve_account") return Response.json({ protocol_version: "vibepub.wechat.v3", operation, operation_id: operationId, attempt: 1, result: { account_binding_id: "wab_synthetic", config_hash: "sha256:" + "a".repeat(64), credential_hash: "sha256:" + "b".repeat(64), receipt_hash: "sha256:" + "c".repeat(64), version: "wechat-account-resolution.v1" } });
          if (operation === "upload_image") return Response.json({ protocol_version: "vibepub.wechat.v3", operation, operation_id: operationId, attempt: body.attempt || 1, result: { media_id: `media-${operationId}`, media_url: `https://wechat.example/${operationId}.png` } });
          if (operation === "write_draft") return Response.json({ protocol_version: "vibepub.wechat.v3", operation, operation_id: operationId, attempt: body.attempt || 1, result: { media_id: "draft-synthetic", mutation: "add" } });
          if (operation === "get_draft") return Response.json({ protocol_version: "vibepub.wechat.v3", operation, operation_id: operationId, attempt: body.attempt || 1, result: { media_id: "draft-synthetic", title: "", html_hash: "", body_urls: [], thumb_media_id: "" } });
          return Response.json({ error: { code: "external_side_effect_unknown", retryable: false } }, { status: 503 });
        },
      },
    },
    wrangler: { configPath: "./wrangler.toml" },
  })],
  test: {
    include: ["test/**/*.runtime.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
