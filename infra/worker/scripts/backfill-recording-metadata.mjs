#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const apiBaseUrl = (process.env.API_BASE_URL || "https://vibepub.litianc.cn").replace(/\/+$/, "");
const filesToken = process.env.FILES_TOKEN || readTokenFromRepo();
const limit = Number(process.env.BACKFILL_LIMIT || "100");

if (!filesToken) {
  console.error("FILES_TOKEN is required. Export it or add secrets/files-token.txt at the repo root.");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${filesToken}` };
const recordings = await getJson(`${apiBaseUrl}/api/recordings`);
const targets = (recordings.recordings || [])
  .filter(recording => recording.status === "COMPLETED" && !recording.article_title)
  .slice(0, limit);

console.log(`Backfill targets: ${targets.length}`);

let updated = 0;
let missing = 0;
let failed = 0;

for (const recording of targets) {
  const transcriptUrl = `${apiBaseUrl}/api/transcripts/${encodeURIComponent(recording.filename)}`;
  const transcriptResponse = await fetch(transcriptUrl, { headers });

  if (transcriptResponse.status === 404) {
    missing += 1;
    console.log(`missing transcript: ${recording.filename}`);
    continue;
  }

  if (!transcriptResponse.ok) {
    failed += 1;
    console.log(`transcript failed ${transcriptResponse.status}: ${recording.filename}`);
    continue;
  }

  const transcript = await transcriptResponse.json();
  const body = {
    filename: recording.filename,
    status: "COMPLETED",
    rawText: transcript.rawText || "",
    articleTitle: transcript.articleTitle || "",
    articleContent: transcript.articleContent || "",
    processingStage: transcript.processingStage || "COMPLETED",
    wechatUrl: transcript.wechatUrl || transcript.wechat_url || undefined,
    wechatDraftId: transcript.wechatDraftId || transcript.mediaId || transcript.wechat_draft_id || undefined,
    errorMessage: transcript.errorMessage || transcript.error_message || undefined,
  };

  const statusResponse = await fetch(`${apiBaseUrl}/api/internal/status`, {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!statusResponse.ok) {
    failed += 1;
    console.log(`status failed ${statusResponse.status}: ${recording.filename}: ${await statusResponse.text()}`);
    continue;
  }

  updated += 1;
  console.log(`updated: ${recording.filename} -> ${body.articleTitle}`);
}

console.log(JSON.stringify({ updated, missing, failed }, null, 2));

async function getJson(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function readTokenFromRepo() {
  const tokenPath = path.resolve(process.cwd(), "../../secrets/files-token.txt");
  if (!fs.existsSync(tokenPath)) return "";
  return fs.readFileSync(tokenPath, "utf8").trim();
}
