import { handleEditorialInternalRoute, handleEditorialRoute } from "./editorialPipeline";
import {
  EditorialCoordinatorAgent,
  EditorialCoverAgent,
  EditorialIllustrationAgent,
  EditorialReviewAgent,
  EditorialVisualProductionAgent,
  EditorialWechatPublishingAgent,
  EditorialWorkflow,
  EditorialWritingAgent,
  coordinatorShardName,
  handleEditorialOrchestrationInternalRoute,
} from "./editorialAgents";
import type { EditorialRuntimeEnv, EditorialWorkflowParams } from "./editorialAgents";
import {
  FiveAgentPublishingWorkflow,
  handleFiveAgentPublishingInternalRoute,
  reconcileFrozenArticleRecordingProjection,
} from "./fiveAgentPublishing";
import type { FiveAgentWorkflowParams } from "./fiveAgentPublishing";
import { handleMiningV3HandoffInternalRoute } from "./miningV3Handoff";
import {
  assertPublicationAction,
  getPublicationRun,
  getPublicationRunEvents,
  getPublicationRunForRecording,
  enrichRecordingList,
  publicationFeatureEnabled,
  publicationTenantFeatureEnabled,
  PublicationProjectionError,
  recordPublicationActionIntent,
  resumePublicationRun,
} from "./publicationProjection";

export {
  EditorialCoordinatorAgent,
  EditorialWritingAgent,
  EditorialReviewAgent,
  EditorialIllustrationAgent,
  EditorialCoverAgent,
  EditorialVisualProductionAgent,
  EditorialWechatPublishingAgent,
  EditorialWorkflow,
  FiveAgentPublishingWorkflow,
};

export interface Env {
  FILES_BUCKET: R2Bucket;
  IMAGES: ImagesBinding;
  DB: D1Database;
  FILES_TOKEN?: string;
  MINING_SERVICE_TOKEN?: string;
  MINING_V3_HANDOFF_TOKEN?: string;
  PUBLISHING_ACCOUNT_RESOLVER_TOKEN?: string;
  PUBLIC_BASE_URL: string;
  GITHUB_PAT?: string;
  GITHUB_WORKFLOW_REF?: string;
  DEPLOY_COMMIT?: string;
  DEPLOY_REF?: string;
  DEPLOYED_AT?: string;
  WRITING_AGENT_BASE_URL?: string;
  WRITING_AGENT_TOKEN?: string;
  REVIEW_AGENT_BASE_URL?: string;
  REVIEW_AGENT_TOKEN?: string;
  WRITING_AGENT?: Fetcher;
  REVIEW_AGENT?: Fetcher;
  IMAGE_GENERATION_ADAPTER?: Fetcher;
  WECHAT_PUBLISHING_ADAPTER?: Fetcher;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  EMAIL?: {
    send(message: {
      to: string | string[];
      from: string | { email: string; name?: string };
      subject: string;
      html?: string;
      text?: string;
    }): Promise<unknown>;
  };
  EMAIL_FROM?: string;
  INVITE_BASE_URL?: string;
  BOOTSTRAP_ADMIN_EMAIL?: string;
  BOOTSTRAP_ADMIN_USER_ID?: string;
  EDITORIAL_WORKFLOW_V2?: string;
  EDITORIAL_WORKFLOW_V2_ALLOWLIST?: string;
  V3_TENANT_SCOPE?: string;
  FIVE_AGENT_PUBLISHING_V3?: string;
  FIVE_AGENT_PUBLISHING_V3_ALLOWLIST?: string;
  DEPLOY_ENVIRONMENT?: string;
  STAGING_IMAGE_CANARY_MODE?: string;
  STAGING_IMAGE_CANARY_RUN_ID?: string;
  STAGING_IMAGE_CANARY_USER_ID?: string;
  STAGING_IMAGE_CANARY_WORKSPACE_ID?: string;
  STAGING_IMAGE_CANARY_SOURCE_KEY?: string;
  STAGING_IMAGE_CANARY_EXPIRES_AT?: string;
  FIVE_AGENT_PUBLISHING_TOKEN?: string;
  VISUAL_PRODUCTION_V3?: string;
  VISUAL_PRODUCTION_V3_ALLOWLIST?: string;
  VISUAL_PRODUCTION_TOKEN?: string;
  WECHAT_DRAFT_SYNC_V3?: string;
  WECHAT_DRAFT_SYNC_V3_ALLOWLIST?: string;
  WECHAT_PUBLISHING_ACCOUNT_ALLOWLIST?: string;
  WECHAT_MEDIA_URL_HOST_ALLOWLIST?: string;
  WECHAT_PUBLISHING_TOKEN?: string;
  EDITORIAL_WORKFLOW: Workflow<EditorialWorkflowParams>;
  FIVE_AGENT_PUBLISHING_WORKFLOW: Workflow<FiveAgentWorkflowParams>;
  EDITORIAL_COORDINATOR: DurableObjectNamespace<EditorialCoordinatorAgent>;
  EDITORIAL_WRITING: DurableObjectNamespace<EditorialWritingAgent>;
  EDITORIAL_REVIEW: DurableObjectNamespace<EditorialReviewAgent>;
  EDITORIAL_VISUAL_PRODUCTION: DurableObjectNamespace<EditorialVisualProductionAgent>;
  EDITORIAL_WECHAT_PUBLISHING: DurableObjectNamespace<EditorialWechatPublishingAgent>;
  EDITORIAL_ILLUSTRATION: DurableObjectNamespace<EditorialIllustrationAgent>;
  EDITORIAL_COVER: DurableObjectNamespace<EditorialCoverAgent>;
}

const MINING_CLAIM_LEASE_MS = 2 * 60 * 60 * 1000;

type AuthContext = {
  userId: string;
  workspaceId: string;
  email: string;
  role: "admin" | "user";
  emailVerified: boolean;
  sessionId?: string;
  accessTokenHash?: string;
  legacy?: boolean;
};

type WritingProfileSelection = {
  styleProfileId?: string;
  styleProfileVersion?: string;
  styleProfileName?: string;
  styleProfileDescription?: string;
  styleProfileBody?: string;
  layoutProfileId?: string;
  layoutProfileVersion?: string;
};

type StatusErrorUpdate = {
  shouldSet: boolean;
  value: string | null;
};

type ArticleFeedbackAction = "adopted" | "not_adopted";

type ArticleFeedbackIdentity = {
  recordingId: number;
  versionId: string;
  action: ArticleFeedbackAction;
  payloadHash: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-File-Name, X-Files-Token, X-Style-Profile-Id, X-Style-Profile-Version, X-Style-Profile-Name-B64, X-Style-Profile-Description-B64, X-Style-Profile-Body-B64, X-Layout-Profile-Id, X-Layout-Profile-Version, X-Article-Version-Id, X-Revision-Request-Id, X-Revision-Audio-Sha256",
};

const MAX_INLINE_STYLE_PROFILE_BODY_CHARS = 3_000;
// Cloudflare Workers Web Crypto currently rejects PBKDF2 iteration counts above 100,000.
const PASSWORD_ITERATIONS = 100_000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1_000;
const REFRESH_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1_000;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1_000;
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_WORKSPACE_ID = "vibepub-dogfood";

type RecordingQueryOptions = {
  includeUserIdFilter: boolean;
  includeDuration: boolean;
  includeProcessingStage: boolean;
  includeCoverImage: boolean;
  includeSourceType: boolean;
  includeStyleProfile: boolean;
  includeLayoutProfile: boolean;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      const adapters = url.searchParams.get("adapters") === "1"
        ? await collectAdapterHealth(env).catch(() => null)
        : undefined;
      if (url.searchParams.get("adapters") === "1" && !adapters) {
        return json({ ok: false, error: "adapter_health_unavailable" }, 503);
      }
      return json({
        ok: true,
        service: "vibepub-api",
        version: deploymentVersion(env),
        ...(adapters ? { adapters } : {}),
      });
    }

    if (url.pathname.startsWith("/api/auth/")) {
      return handleAuthRoute(request, env, url);
    }

    if (request.method === "PUT" && url.pathname === "/api/internal/status") {
      if (!(await isInternalAuthorized(request, env))) {
        return json({ error: "unauthorized" }, 401);
      }
      return updateStatus(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/internal/publishing-account") {
      if (!(await isInternalAuthorized(request, env)) && !(await isPublishingAccountResolverAuthorized(request, env))) {
        return json({ error: "unauthorized" }, 401);
      }
      return getInternalPublishingAccount(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/internal/mining-claims") {
      if (!(await isInternalAuthorized(request, env))) {
        return json({ error: "unauthorized" }, 401);
      }
      return handleMiningClaim(request, env);
    }

    if (url.pathname.startsWith("/api/internal/editorial/")) {
      if (!(await isInternalAuthorized(request, env))) {
        return json({ error: "unauthorized" }, 401);
      }
      if (url.pathname.startsWith("/api/internal/editorial/runs")) {
        const editorialEnv = env as unknown as EditorialRuntimeEnv;
        return handleEditorialOrchestrationInternalRoute(request, editorialEnv, url);
      }
      return handleEditorialInternalRoute(request, env, url);
    }

    if (url.pathname.startsWith("/api/internal/v3/publishing/")) {
      if (!(await isFiveAgentPublishingAuthorized(request, env))) {
        return json({ error: "unauthorized" }, 401);
      }
      return handleFiveAgentPublishingInternalRoute(request, env, url);
    }

    if (url.pathname.startsWith("/api/internal/v3/mining-handoffs/")) {
      if (!(await isMiningV3HandoffAuthorized(request, env))) {
        return json({ error: "unauthorized" }, 401);
      }
      return handleMiningV3HandoffInternalRoute(request, env, url);
    }

    const articleRevisionInternalMatch = url.pathname.match(
      /^\/api\/internal\/v3\/article-revisions\/([^/]+)\/(version|status)$/,
    );
    if (request.method === "POST" && articleRevisionInternalMatch) {
      if (!(await isMiningV3HandoffAuthorized(request, env))) {
        return json({ error: "unauthorized" }, 401);
      }
      return handleArticleRevisionInternal(
        request,
        env,
        safeDecodeURIComponent(articleRevisionInternalMatch[1]),
        articleRevisionInternalMatch[2] as "version" | "status",
      );
    }

    if (!url.pathname.startsWith("/api/")) {
      return json({ error: "not_found" }, 404);
    }

    const auth = await authenticateRequest(request, env);
    if (!auth) {
      return json({ error: "unauthorized" }, 401);
    }

    if (url.pathname.startsWith("/api/editorial/")) {
      if (request.method !== "GET") {
        const verified = requireVerifiedEmail(auth);
        if (verified) return verified;
      }
      return handleEditorialRoute(request, env, url, auth);
    }

    if (request.method === "GET" && url.pathname === "/api/me") {
      return json({ user: publicUser(auth) });
    }

    if (request.method === "GET" && url.pathname === "/api/publishing-account") {
      return getPublishingAccount(env, auth);
    }

    if (request.method === "PUT" && url.pathname === "/api/publishing-account") {
      const verified = requireVerifiedEmail(auth);
      if (verified) return verified;
      return updatePublishingAccount(request, env, auth);
    }

    if (url.pathname.startsWith("/api/admin/")) {
      if (auth.role !== "admin") {
        return json({ error: "forbidden" }, 403);
      }
      return handleAdminRoute(request, env, url, auth);
    }

    if (request.method === "POST" && url.pathname === "/api/uploads") {
      const verified = requireVerifiedEmail(auth);
      if (verified) return verified;
      return uploadAudio(request, env, ctx, auth);
    }

    if (request.method === "POST" && url.pathname === "/api/text-submissions") {
      const verified = requireVerifiedEmail(auth);
      if (verified) return verified;
      return submitText(request, env, ctx, auth);
    }

    if (request.method === "GET" && url.pathname === "/api/style-profiles") {
      return proxyWritingAgent(request, env, "/v1/style-profiles", auth);
    }

    if (
      (request.method === "GET" || request.method === "POST") &&
      url.pathname.startsWith("/api/style-profiles/")
    ) {
      return proxyWritingAgent(
        request,
        env,
        `/v1/style-profiles/${url.pathname.slice("/api/style-profiles/".length)}`,
        auth,
      );
    }

    if (
      (request.method === "GET" || request.method === "POST") &&
      url.pathname === "/api/style-source-imports"
    ) {
      if (request.method === "POST") {
        const verified = requireVerifiedEmail(auth);
        if (verified) return verified;
      }
      return proxyWritingAgent(request, env, "/v1/style-source-imports", auth);
    }

    if (request.method === "POST" && url.pathname === "/api/style-distillation-jobs") {
      const verified = requireVerifiedEmail(auth);
      if (verified) return verified;
      return proxyWritingAgent(request, env, "/v1/style-distillation-jobs", auth);
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/style-distillation-jobs/")) {
      return proxyWritingAgent(
        request,
        env,
        `/v1/style-distillation-jobs/${url.pathname.slice("/api/style-distillation-jobs/".length)}`,
        auth,
      );
    }

    if (request.method === "GET" && url.pathname === "/api/uploads") {
      return listUploads(env, url, auth);
    }

    if (request.method === "GET" && url.pathname === "/api/recordings") {
      return listRecordings(env, auth);
    }

    const recordingPublicationMatch = url.pathname.match(/^\/api\/recordings\/(\d+)\/publication-run$/);
    if (request.method === "GET" && recordingPublicationMatch) {
      if (!publicationTenantFeatureEnabled(env, auth.userId, auth.workspaceId)) {
        return json({ error: "publication_workflow_disabled" }, 404);
      }
      return publicationRoute(async () => {
        const result = await getPublicationRunForRecording(env.DB, auth, Number(recordingPublicationMatch[1]));
        const runId = String((result.run as Record<string, unknown> | undefined)?.run_id || "");
        if (!publicationFeatureEnabled(env, auth.userId, auth.workspaceId, runId)) {
          throw new PublicationProjectionError("publication_workflow_disabled", "publication workflow disabled", 404);
        }
        if (url.searchParams.get("diagnostics") === "wechat_calls") {
          const run = result.run as Record<string, unknown>;
          const articleId = String(run.article_id || "");
          if (!articleId || !runId) {
            throw new PublicationProjectionError("publication_run_unavailable", "publication run identity unavailable", 503);
          }
          const coordinator = env.EDITORIAL_COORDINATOR.getByName(
            await coordinatorShardName(auth.userId, auth.workspaceId, articleId, runId),
          );
          const calls = (await coordinator.listFiveAgentCallAttempts(runId, auth.userId, auth.workspaceId))
            .filter(call => call.call_kind.startsWith("wechat_"))
            .map(call => ({
              call_kind: call.call_kind,
              operation_id: call.idempotency_key,
              attempt: call.attempt,
              status: call.status,
              error_code: call.error_code,
              retryable: call.retryable,
            }));
          const ledger = await coordinator.getFiveAgentWechatLedger(runId, auth.userId, auth.workspaceId);
          const receiptIds = new Set(ledger.receipt_ids);
          const readbacks = [...ledger.artifacts].reverse().filter(artifact =>
            artifact.kind === "wechat_draft_readback_qa" && receiptIds.has(artifact.artifact_id)
          );
          let readbackChecks: Record<string, boolean | number | string> | null = null;
          for (const readback of readbacks) {
            if (!readback.storage_ref.startsWith("r2://")) continue;
            const object = await env.FILES_BUCKET.get(readback.storage_ref.slice("r2://".length));
            const parsed = object ? await object.json().catch(() => null) as Record<string, unknown> | null : null;
            const payload = parsed?.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
              ? parsed.payload as Record<string, unknown>
              : null;
            const checks = payload?.checks && typeof payload.checks === "object" && !Array.isArray(payload.checks)
              ? payload.checks as Record<string, unknown>
              : null;
            if (checks) {
              readbackChecks = {
                decision: payload?.decision === "pass" ? "pass" : "failed",
                media: checks.media === true,
                title: checks.title === true,
                html: checks.html === true,
                urls: checks.urls === true,
                thumb: checks.thumb === true,
                article_index: Number(checks.article_index),
              };
              if (readbackChecks.decision === "pass") break;
            }
          }
          return {
            ...result,
            diagnostics: {
              wechat_calls: calls,
              wechat_artifacts: ledger.artifacts.map(artifact => ({
                kind: artifact.kind,
                storage_ref: artifact.storage_ref,
                receipt_present: receiptIds.has(artifact.artifact_id),
              })),
              readback_checks: readbackChecks,
            },
          };
        }
        return result;
      });
    }

    const publicationEventsMatch = url.pathname.match(/^\/api\/publication-runs\/([^/]+)\/events$/);
    if (request.method === "GET" && publicationEventsMatch) {
      const runId = safeDecodeURIComponent(publicationEventsMatch[1]);
      if (!publicationFeatureEnabled(env, auth.userId, auth.workspaceId, runId)) {
        return json({ error: "publication_workflow_disabled" }, 404);
      }
      const afterRevisionParam = url.searchParams.get("after_revision");
      const afterRevision = afterRevisionParam === null ? -1 : Number(afterRevisionParam);
      const limit = Number(url.searchParams.get("limit") || "50");
      return publicationRoute(() => getPublicationRunEvents(
        env.DB,
        auth,
        runId,
        afterRevision,
        limit,
      ));
    }

    const publicationActionMatch = url.pathname.match(/^\/api\/publication-runs\/([^/]+)\/(retry|cancel|actions)$/);
    if (request.method === "POST" && publicationActionMatch) {
      const verified = requireVerifiedEmail(auth);
      if (verified) return verified;
      const runId = safeDecodeURIComponent(publicationActionMatch[1]);
      if (!publicationFeatureEnabled(env, auth.userId, auth.workspaceId, runId)) {
        return json({ error: "publication_workflow_disabled" }, 404);
      }
      const body = await parseJson(request);
      const endpointAction = publicationActionMatch[2];
      const action = endpointAction === "actions"
        ? normalizeOptionalString(body?.action)
        : endpointAction;
      const idempotencyKey = normalizeOptionalString(
        body?.idempotency_key ?? body?.idempotencyKey ?? request.headers.get("Idempotency-Key"),
      );
      const expectedStateRevision = Number(body?.expected_state_revision ?? body?.expectedStateRevision);
      if (!action || !idempotencyKey) return json({ error: "idempotency_key_required" }, 400);
      if (!Number.isSafeInteger(expectedStateRevision) || expectedStateRevision < 0) {
        return json({ error: "expected_state_revision_required" }, 400);
      }
      const payloadHash = `sha256:${await sha256Hex(JSON.stringify({
        action,
        expected_state_revision: expectedStateRevision,
        contract: endpointAction === "actions" ? "human.v1" : "system.v1",
      }))}`;
      return publicationRoute(async () => endpointAction === "actions"
        ? recordPublicationActionIntent(
          env.DB,
          auth,
          runId,
          action as "confirm" | "abandon" | "resume",
          idempotencyKey,
          payloadHash,
          expectedStateRevision,
        )
        : endpointAction === "retry"
          ? retryPublicationWritingAfterServiceFix(
            env,
            auth,
            runId,
            idempotencyKey,
            payloadHash,
            expectedStateRevision,
          )
          : assertPublicationAction(
            env.DB,
            auth,
            runId,
            action,
            idempotencyKey,
            payloadHash,
            expectedStateRevision,
          ));
    }

    const feedbackFilename = recordingFilenameForSubresource(url.pathname, "/article-feedback");
    if (request.method === "GET" && feedbackFilename) {
      return getArticleFeedback(env, auth, feedbackFilename);
    }
    if (request.method === "POST" && feedbackFilename) {
      const verified = requireVerifiedEmail(auth);
      if (verified) return verified;
      return createArticleFeedback(request, env, auth, feedbackFilename);
    }

    if (request.method === "POST" && isRecordingRevisionPath(url.pathname)) {
      const verified = requireVerifiedEmail(auth);
      if (verified) return verified;
      const filename = safeDecodeURIComponent(
        url.pathname.slice("/api/recordings/".length, -"/revisions".length),
      );
      return createArticleRevision(request, env, ctx, auth, filename);
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/recordings/")) {
      const filename = safeDecodeURIComponent(url.pathname.slice("/api/recordings/".length));
      return deleteRecording(env, auth, filename);
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/files/")) {
      return getFile(env, auth, url.pathname.slice("/api/files/".length));
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/transcripts/")) {
      const filename = safeDecodeURIComponent(url.pathname.slice("/api/transcripts/".length));
      return getTranscript(env, auth, filename);
    }

    return json({ error: "not_found" }, 404);
  },
};

async function handleAuthRoute(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    return login(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/auth/refresh") {
    return refreshSession(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/auth/accept-invite") {
    return acceptInvite(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/auth/verify-email") {
    return verifyEmail(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/auth/request-password-reset") {
    return requestPasswordReset(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/auth/reset-password") {
    return resetPassword(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const auth = await authenticateRequest(request, env);
    if (!auth) return json({ ok: true });
    return logout(request, env, auth);
  }
  return json({ error: "not_found" }, 404);
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const email = normalizeEmail(body?.email);
  const password = normalizeOptionalString(body?.password);
  if (!email || !password) {
    return json({ error: "missing_credentials" }, 400);
  }

  const user = await queryOne<any>(
    env,
    `SELECT id, email, password_hash, password_salt, password_iterations, role, workspace_id, status, email_verified_at
     FROM users WHERE email = ? LIMIT 1`,
    [email],
  );
  if (!user || user.status === "disabled") {
    return json({ error: "invalid_credentials" }, 401);
  }

  const valid = await verifyPassword(password, user.password_salt, user.password_hash, user.password_iterations);
  if (!valid) {
    return json({ error: "invalid_credentials" }, 401);
  }

  if (!user.email_verified_at) {
    return json({ error: "email_unverified", message: "请先完成邮箱验证" }, 403);
  }

  const auth = authFromUserRow(user);
  return json({
    user: publicUser(auth),
    tokens: await createSession(env, auth.userId),
  });
}

async function refreshSession(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const refreshToken = normalizeOptionalString(body?.refresh_token ?? body?.refreshToken);
  if (!refreshToken) {
    return json({ error: "missing_refresh_token" }, 400);
  }
  const refreshHash = await sha256Hex(refreshToken);
  const session = await queryOne<any>(
    env,
    `SELECT s.id AS session_id, s.user_id AS id, s.refresh_expires_at, s.revoked_at,
            u.email, u.role, u.workspace_id, u.status, u.email_verified_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.refresh_token_hash = ? LIMIT 1`,
    [refreshHash],
  );
  if (!session || session.revoked_at || isPast(session.refresh_expires_at) || session.status === "disabled") {
    return json(
      { error: "invalid_refresh_token" },
      401,
      { "x-vibepub-auth-error": "invalid_refresh_token" },
    );
  }

  // Keep the refresh token stable. A lost refresh response or a duplicate
  // request can then replay safely instead of stranding the device on a token
  // that the server has already rotated away.
  const tokens = sessionTokens(refreshToken);
  const updated = await env.DB.prepare(
    `UPDATE sessions
     SET access_token_hash = ?, refresh_token_hash = ?, access_expires_at = ?, refresh_expires_at = ?, updated_at = ?
     WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL`,
  )
    .bind(
      await sha256Hex(tokens.accessToken),
      await sha256Hex(tokens.refreshToken),
      isoAfter(ACCESS_TOKEN_TTL_MS),
      isoAfter(REFRESH_TOKEN_TTL_MS),
      nowIso(),
      session.session_id,
      refreshHash,
    )
    .run();
  if (Number(updated.meta?.changes || 0) !== 1) {
    return json(
      { error: "invalid_refresh_token" },
      401,
      { "x-vibepub-auth-error": "invalid_refresh_token" },
    );
  }

  return json({
    user: publicUser(authFromUserRow(session)),
    tokens: publicTokens(tokens),
  });
}

async function acceptInvite(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const token = normalizeOptionalString(body?.token);
  const password = normalizeOptionalString(body?.password);
  if (!token || !password) {
    return json({ error: "missing_fields" }, 400);
  }
  const passwordError = validatePassword(password);
  if (passwordError) return passwordError;

  const invitation = await queryOne<any>(
    env,
    `SELECT id, email, role, token_hash, expires_at, accepted_at
     FROM invitations WHERE token_hash = ? LIMIT 1`,
    [await sha256Hex(token)],
  );
  if (!invitation || invitation.accepted_at || isPast(invitation.expires_at)) {
    return json({ error: "invalid_invitation" }, 400);
  }

  const email = normalizeEmail(invitation.email);
  const existing = await queryOne<any>(env, `SELECT id FROM users WHERE email = ? LIMIT 1`, [email]);
  const passwordHash = await hashPassword(password);
  const userId = existing?.id || `usr_${crypto.randomUUID()}`;
  const workspaceId = `ws_${userId.replace(/^usr_/, "")}`;
  const verifiedAt = nowIso();

  if (existing) {
    await env.DB.prepare(
      `UPDATE users
       SET password_hash = ?, password_salt = ?, password_iterations = ?, role = ?, status = 'active',
           email_verified_at = COALESCE(email_verified_at, ?), updated_at = ?
       WHERE id = ?`,
    )
      .bind(passwordHash.hash, passwordHash.salt, passwordHash.iterations, invitation.role || "user", verifiedAt, verifiedAt, userId)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO users
        (id, email, password_hash, password_salt, password_iterations, role, workspace_id, status, email_verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
      .bind(
        userId,
        email,
        passwordHash.hash,
        passwordHash.salt,
        passwordHash.iterations,
        invitation.role || "user",
        workspaceId,
        verifiedAt,
        verifiedAt,
        verifiedAt,
      )
      .run();
  }

  await env.DB.prepare(`UPDATE invitations SET accepted_at = ?, updated_at = ? WHERE id = ?`)
    .bind(verifiedAt, verifiedAt, invitation.id)
    .run();

  const auth = {
    userId,
    workspaceId,
    email,
    role: invitation.role === "admin" ? "admin" : "user",
    emailVerified: true,
  } satisfies AuthContext;

  return json({
    user: publicUser(auth),
    tokens: await createSession(env, userId),
  }, 201);
}

async function verifyEmail(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const token = normalizeOptionalString(body?.token);
  if (!token) return json({ error: "missing_token" }, 400);
  const row = await queryOne<any>(
    env,
    `SELECT id, user_id, expires_at, consumed_at
     FROM email_verification_tokens WHERE token_hash = ? LIMIT 1`,
    [await sha256Hex(token)],
  );
  if (!row || row.consumed_at || isPast(row.expires_at)) {
    return json({ error: "invalid_token" }, 400);
  }
  const now = nowIso();
  await env.DB.prepare(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?`)
    .bind(now, now, row.user_id)
    .run();
  await env.DB.prepare(`UPDATE email_verification_tokens SET consumed_at = ? WHERE id = ?`)
    .bind(now, row.id)
    .run();
  return json({ ok: true });
}

async function requestPasswordReset(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const email = normalizeEmail(body?.email);
  if (!email) return json({ ok: true });
  const user = await queryOne<any>(env, `SELECT id, email FROM users WHERE email = ? AND status != 'disabled' LIMIT 1`, [email]);
  if (user) {
    const token = randomToken();
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(`prt_${crypto.randomUUID()}`, user.id, await sha256Hex(token), isoAfter(PASSWORD_RESET_TTL_MS), now)
      .run();
    await sendTransactionalEmail(env, {
      to: user.email,
      subject: "重设你的 VibePub 密码",
      text: `使用这个链接重设密码：${authLink(env, "reset-password", token)}`,
      html: `<p>使用这个链接重设密码：</p><p><a href="${authLink(env, "reset-password", token)}">重设密码</a></p>`,
    });
  }
  return json({ ok: true });
}

async function resetPassword(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const token = normalizeOptionalString(body?.token);
  const password = normalizeOptionalString(body?.password);
  if (!token || !password) return json({ error: "missing_fields" }, 400);
  const passwordError = validatePassword(password);
  if (passwordError) return passwordError;
  const row = await queryOne<any>(
    env,
    `SELECT id, user_id, expires_at, consumed_at FROM password_reset_tokens WHERE token_hash = ? LIMIT 1`,
    [await sha256Hex(token)],
  );
  if (!row || row.consumed_at || isPast(row.expires_at)) {
    return json({ error: "invalid_token" }, 400);
  }
  const passwordHash = await hashPassword(password);
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE users
     SET password_hash = ?, password_salt = ?, password_iterations = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(passwordHash.hash, passwordHash.salt, passwordHash.iterations, now, row.user_id)
    .run();
  await env.DB.prepare(`UPDATE password_reset_tokens SET consumed_at = ? WHERE id = ?`)
    .bind(now, row.id)
    .run();
  await env.DB.prepare(`UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE user_id = ?`)
    .bind(now, now, row.user_id)
    .run();
  return json({ ok: true });
}

async function logout(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const now = nowIso();
  let refreshHash: string | null = null;
  try {
    const body = await request.clone().json() as any;
    const refreshToken = normalizeOptionalString(body?.refresh_token ?? body?.refreshToken);
    refreshHash = refreshToken ? await sha256Hex(refreshToken) : null;
  } catch {
    refreshHash = null;
  }

  if (auth.sessionId) {
    await env.DB.prepare(`UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ?`)
      .bind(now, now, auth.sessionId)
      .run();
  } else if (refreshHash) {
    await env.DB.prepare(`UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE refresh_token_hash = ?`)
      .bind(now, now, refreshHash)
      .run();
  }
  return json({ ok: true });
}

async function handleAdminRoute(request: Request, env: Env, url: URL, auth: AuthContext): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/admin/users") {
    const users = await queryAll<any>(
      env,
      `SELECT id, email, role, workspace_id, status, email_verified_at, created_at, updated_at
       FROM users ORDER BY created_at DESC LIMIT 200`,
    );
    const invitations = await queryAll<any>(
      env,
      `SELECT id, email, role, expires_at, accepted_at, created_at
       FROM invitations
       WHERE accepted_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 200`,
      [nowIso()],
    );
    return json({ users, invitations });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/users") {
    const body = await parseJson(request);
    const email = normalizeEmail(body?.email);
    const role = body?.role === "admin" ? "admin" : "user";
    if (!email) return json({ error: "invalid_email" }, 400);
    const token = randomToken();
    const now = nowIso();
    const invitationId = `inv_${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO invitations (id, email, role, token_hash, invited_by_user_id, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(invitationId, email, role, await sha256Hex(token), auth.userId, isoAfter(INVITATION_TTL_MS), now, now)
      .run();
    const inviteUrl = authLink(env, "accept-invite", token);
    await sendTransactionalEmail(env, {
      to: email,
      subject: "VibePub 邀请",
      text: `你已被邀请使用 VibePub。请打开链接设置密码：${inviteUrl}`,
      html: `<p>你已被邀请使用 VibePub。</p><p><a href="${inviteUrl}">设置密码并开始使用</a></p>`,
    });
    return json({ invitation: { id: invitationId, email, role, invite_url: inviteUrl, token } }, 201);
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/admin/users/") && url.pathname.endsWith("/disable")) {
    const userId = safeDecodeURIComponent(url.pathname.slice("/api/admin/users/".length, -"/disable".length));
    if (userId === auth.userId) return json({ error: "cannot_disable_self" }, 400);
    await env.DB.prepare(`UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?`)
      .bind(nowIso(), userId)
      .run();
    await env.DB.prepare(`UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE user_id = ?`)
      .bind(nowIso(), nowIso(), userId)
      .run();
    return json({ ok: true });
  }

  return json({ error: "not_found" }, 404);
}

async function authenticateRequest(request: Request, env: Env): Promise<AuthContext | null> {
  const legacyHeaderToken = normalizeOptionalString(request.headers.get("x-files-token"));
  const legacyToken = env.FILES_TOKEN?.trim();
  if (legacyHeaderToken && legacyToken && await secureTokenEquals(legacyToken, legacyHeaderToken)) {
    return legacyAdminContext(env);
  }

  const token = bearerToken(request) || legacyHeaderToken || "";
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  try {
    const row = await queryOne<any>(
      env,
      `SELECT s.id AS session_id, s.access_expires_at, s.revoked_at,
              u.id, u.email, u.role, u.workspace_id, u.status, u.email_verified_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.access_token_hash = ? LIMIT 1`,
      [tokenHash],
    );
    if (row && !row.revoked_at && !isPast(row.access_expires_at) && row.status !== "disabled") {
      const auth = authFromUserRow(row);
      auth.sessionId = row.session_id;
      auth.accessTokenHash = tokenHash;
      return auth;
    }
  } catch (error: any) {
    const message = String(error?.message || "");
    if (!message.includes("no such table")) {
      throw error;
    }
  }

  if (legacyToken && await secureTokenEquals(legacyToken, token)) {
    return legacyAdminContext(env);
  }
  return null;
}

async function isInternalAuthorized(request: Request, env: Env): Promise<boolean> {
  const token = bearerToken(request) || normalizeOptionalString(request.headers.get("x-files-token")) || "";
  if (!token) return false;
  const internal = env.MINING_SERVICE_TOKEN?.trim();
  if (internal && await secureTokenEquals(internal, token)) return true;
  const legacy = env.FILES_TOKEN?.trim();
  return Boolean(legacy && await secureTokenEquals(legacy, token));
}

async function isFiveAgentPublishingAuthorized(request: Request, env: Env): Promise<boolean> {
  const configured = env.FIVE_AGENT_PUBLISHING_TOKEN?.trim();
  if (!configured) return false;
  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || request.headers.get("X-Five-Agent-Publishing-Token") || "";
  return Boolean(bearer) && await secureTokenEquals(configured, bearer);
}

async function isMiningV3HandoffAuthorized(request: Request, env: Env): Promise<boolean> {
  const configured = env.MINING_V3_HANDOFF_TOKEN?.trim();
  if (!configured) return false;
  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  return Boolean(bearer) && await secureTokenEquals(configured, bearer);
}

async function isPublishingAccountResolverAuthorized(request: Request, env: Env): Promise<boolean> {
  const configured = env.PUBLISHING_ACCOUNT_RESOLVER_TOKEN?.trim();
  if (!configured) return false;
  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  return Boolean(bearer) && await secureTokenEquals(configured, bearer);
}

function requireVerifiedEmail(auth: AuthContext): Response | null {
  return auth.emailVerified
    ? null
    : json({ error: "email_unverified", message: "请先完成邮箱验证" }, 403);
}

function authFromUserRow(row: any): AuthContext {
  return {
    userId: row.id || row.user_id,
    workspaceId: row.workspace_id || DEFAULT_WORKSPACE_ID,
    email: row.email,
    role: row.role === "admin" ? "admin" : "user",
    emailVerified: Boolean(row.email_verified_at),
  };
}

function legacyAdminContext(env: Env): AuthContext {
  const userId = bootstrapAdminUserId(env);
  return {
    userId,
    workspaceId: DEFAULT_WORKSPACE_ID,
    email: env.BOOTSTRAP_ADMIN_EMAIL?.trim() || "bootstrap@vibepub.local",
    role: "admin",
    emailVerified: true,
    legacy: true,
  };
}

function bootstrapAdminUserId(env: Env): string {
  return env.BOOTSTRAP_ADMIN_USER_ID?.trim() || "default_user";
}

function publicUser(auth: AuthContext): Record<string, unknown> {
  return {
    id: auth.userId,
    email: auth.email,
    role: auth.role,
    workspace_id: auth.workspaceId,
    email_verified: auth.emailVerified,
  };
}

async function createSession(env: Env, userId: string): Promise<Record<string, unknown>> {
  const tokens = sessionTokens();
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO sessions
      (id, user_id, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      `ses_${crypto.randomUUID()}`,
      userId,
      await sha256Hex(tokens.accessToken),
      await sha256Hex(tokens.refreshToken),
      isoAfter(ACCESS_TOKEN_TTL_MS),
      isoAfter(REFRESH_TOKEN_TTL_MS),
      now,
      now,
    )
    .run();
  return publicTokens(tokens);
}

function sessionTokens(refreshToken = randomToken()): { accessToken: string; refreshToken: string } {
  return {
    accessToken: randomToken(),
    refreshToken,
  };
}

function publicTokens(tokens: { accessToken: string; refreshToken: string }): Record<string, unknown> {
  return {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
  };
}

async function proxyWritingAgent(
  request: Request,
  env: Env,
  targetPath: string,
  auth: AuthContext,
): Promise<Response> {
  const baseUrl = env.WRITING_AGENT_BASE_URL?.trim();
  const token = env.WRITING_AGENT_TOKEN?.trim() || env.FILES_TOKEN?.trim();
  if (!baseUrl || !token) {
    return json({
      error: "writing_agent_unconfigured",
      message: "WritingAgent proxy is not configured",
    }, 503);
  }

  const sourceUrl = new URL(request.url);
  const target = new URL(`${baseUrl.replace(/\/+$/, "")}${targetPath}`);
  sourceUrl.searchParams.forEach((value, key) => {
    if (key !== "workspace_id" && key !== "user_id") {
      target.searchParams.set(key, value);
    }
  });
  target.searchParams.set("workspace_id", auth.workspaceId);

  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-VibePub-User-Id", auth.userId);
  headers.set("X-VibePub-Workspace-Id", auth.workspaceId);
  const contentType = request.headers.get("content-type");
  if (contentType) {
    headers.set("Content-Type", contentType);
  }

  const upstream = await fetch(target.toString(), {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
  });
  const responseHeaders = new Headers(corsHeaders);
  const upstreamContentType = upstream.headers.get("content-type");
  responseHeaders.set("content-type", upstreamContentType || "application/json; charset=utf-8");

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: responseHeaders,
  });
}

async function submitText(request: Request, env: Env, ctx: ExecutionContext, auth: AuthContext): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json", message: "文字提交内容不是有效 JSON" }, 400);
  }

  const text = normalizeOptionalString(body?.text);
  if (!text || text.length < 10) {
    return json({ error: "text_too_short", message: "文字太短，请再补充一些想法" }, 400);
  }
  if (text.length > 30_000) {
    return json({ error: "text_too_long", message: "文字太长，请分成多次提交" }, 400);
  }

  const titleHint = normalizeOptionalString(body?.title_hint ?? body?.titleHint);
  const profileSelection = normalizeProfileSelectionFromBody(body);
  const submittedAt = new Date().toISOString();
  const safeTimestamp = submittedAt.replace(/[:.]/g, "-").replace("T", "-").replace("Z", "");
  const filename = sanitizeFileName(`VibePub-${safeTimestamp}-Text-${crypto.randomUUID().slice(0, 8)}.txt`);
  const key = userScopedKey(auth.userId, "text-submissions", filename);
  const payload = {
    filename,
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    text,
    titleHint,
    source: normalizeOptionalString(body?.source) || "android_text",
    submittedAt,
    styleProfileId: profileSelection.styleProfileId,
    styleProfileVersion: profileSelection.styleProfileVersion,
    styleProfileName: profileSelection.styleProfileName,
    styleProfileDescription: profileSelection.styleProfileDescription,
    styleProfileBody: profileSelection.styleProfileBody,
    layoutProfileId: profileSelection.layoutProfileId,
    layoutProfileVersion: profileSelection.layoutProfileVersion,
  };

  await env.FILES_BUCKET.put(key, JSON.stringify(payload, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      filename,
      userId: auth.userId,
      workspaceId: auth.workspaceId,
      submittedAt,
      sourceType: "TEXT",
      ...profileSelectionMetadata(profileSelection),
    },
  });

  await upsertTextRecording(env, auth, {
    filename,
    key,
    text,
    titleHint,
    profileSelection,
  });

  ctx.waitUntil(triggerGitHubAction(env, {
    targetFilename: filename,
    targetKey: key,
    userId: auth.userId,
  }).catch((e) => {
    console.error("Failed to trigger GitHub Action for text submission:", e);
  }));

  return json({
    ok: true,
    key,
    filename,
    status: "PROCESSING",
    processing_stage: "REWRITING",
    submitted_at: submittedAt,
  }, 202);
}

async function upsertTextRecording(
  env: Env,
  auth: AuthContext,
  input: {
    filename: string;
    key: string;
    text: string;
    titleHint?: string | null;
    profileSelection?: WritingProfileSelection;
  },
): Promise<void> {
  const updated = await env.DB.prepare(
    `
    UPDATE recordings
    SET r2_key = ?, status = ?, processing_stage = ?, duration_ms = 0, raw_text = ?, article_title = COALESCE(?, article_title), source_type = ?, style_profile_id = COALESCE(?, style_profile_id), style_profile_version = COALESCE(?, style_profile_version), layout_profile_id = COALESCE(?, layout_profile_id), layout_profile_version = COALESCE(?, layout_profile_version), error_message = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND filename = ?
    `,
  )
    .bind(
      input.key,
      "PROCESSING",
      "REWRITING",
      input.text,
      input.titleHint || null,
      "TEXT",
      input.profileSelection?.styleProfileId || null,
      input.profileSelection?.styleProfileVersion || null,
      input.profileSelection?.layoutProfileId || null,
      input.profileSelection?.layoutProfileVersion || null,
      auth.userId,
      input.filename,
    )
    .run();

  if ((updated.meta.changes ?? 0) === 0) {
    const values = [
      auth.userId,
      auth.workspaceId,
      input.filename,
      input.key,
      "PROCESSING",
      "REWRITING",
      0,
      input.text,
      input.titleHint || null,
      "TEXT",
      input.profileSelection?.styleProfileId || null,
      input.profileSelection?.styleProfileVersion || null,
      input.profileSelection?.layoutProfileId || null,
      input.profileSelection?.layoutProfileVersion || null,
    ];
    try {
      await env.DB.prepare(
        `
        INSERT INTO recordings (user_id, workspace_id, filename, r2_key, status, processing_stage, duration_ms, raw_text, article_title, source_type, style_profile_id, style_profile_version, layout_profile_id, layout_profile_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).bind(...values).run();
    } catch (error) {
      if (!String((error as any)?.message || error).includes("workspace_id")) throw error;
      await env.DB.prepare(
        `
        INSERT INTO recordings (user_id, filename, r2_key, status, processing_stage, duration_ms, raw_text, article_title, source_type, style_profile_id, style_profile_version, layout_profile_id, layout_profile_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).bind(...values.filter((_, index) => index !== 1)).run();
    }
  }
  await ensureEditorialRecordingScope(env, auth, input.filename);
}

async function uploadAudio(request: Request, env: Env, ctx: ExecutionContext, auth: AuthContext): Promise<Response> {
  if (!request.body) {
    return json({ error: "missing_body" }, 400);
  }

  const originalName = request.headers.get("x-file-name") || "recording.m4a";
  const safeOriginalName = sanitizeFileName(originalName);
  const uploadedAt = new Date().toISOString();
  const keyPrefix = safeOriginalName.startsWith("VibePub-") || safeOriginalName.startsWith("VoiceDrop-")
    ? ""
    : `${uploadedAt.replace(/[:.]/g, "-")}-`;
  const key = userScopedKey(auth.userId, "inbox", `${keyPrefix}${safeOriginalName}`);
  const contentType = request.headers.get("content-type") || "audio/mp4";
  const profileSelection = normalizeProfileSelectionFromHeaders(request.headers);

  await env.FILES_BUCKET.put(key, request.body, {
    httpMetadata: { contentType },
    customMetadata: {
      originalName,
      userId: auth.userId,
      workspaceId: auth.workspaceId,
      uploadedAt,
      ...profileSelectionMetadata(profileSelection),
    },
  });

  if (hasInlineProfileSelection(profileSelection)) {
    await env.FILES_BUCKET.put(
      profileSelectionSidecarKey(auth.userId, safeOriginalName),
      JSON.stringify({
        filename: safeOriginalName,
        userId: auth.userId,
        workspaceId: auth.workspaceId,
        uploadedAt,
        ...profileSelectionPayload(profileSelection),
      }, null, 2),
      { httpMetadata: { contentType: "application/json; charset=utf-8" } },
    );
  }

  const durationMs = parseDurationMsFromRecordingFilename(safeOriginalName);
  await upsertUploadedRecording(env, auth, {
    filename: safeOriginalName,
    key,
    durationMs,
    profileSelection,
  });

  ctx.waitUntil(triggerGitHubAction(env, {
    targetFilename: safeOriginalName,
    targetKey: key,
    userId: auth.userId,
  }).catch((e) => {
    console.error("Failed to trigger GitHub Action:", e);
  }));

  return json(
    {
      ok: true,
      key,
      name: safeOriginalName,
      uploadedAt,
      url: `${env.PUBLIC_BASE_URL}/api/files/${encodeURIComponent(key)}`,
    },
    201,
  );
}

async function upsertUploadedRecording(
  env: Env,
  auth: AuthContext,
  input: {
    filename: string;
    key: string;
    durationMs: number | null;
    profileSelection: WritingProfileSelection;
  },
): Promise<void> {
  try {
    const updated = await env.DB.prepare(
      `
      UPDATE recordings
      SET r2_key = ?, status = ?, processing_stage = ?, duration_ms = COALESCE(?, duration_ms), style_profile_id = COALESCE(?, style_profile_id), style_profile_version = COALESCE(?, style_profile_version), layout_profile_id = COALESCE(?, layout_profile_id), layout_profile_version = COALESCE(?, layout_profile_version), error_message = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND filename = ?
      `,
    )
      .bind(
        input.key,
        "UPLOADED",
        "QUEUED",
        input.durationMs,
        input.profileSelection.styleProfileId || null,
        input.profileSelection.styleProfileVersion || null,
        input.profileSelection.layoutProfileId || null,
        input.profileSelection.layoutProfileVersion || null,
        auth.userId,
        input.filename,
      )
      .run();

    if ((updated.meta.changes ?? 0) === 0) {
      await insertUploadedRecording(env, auth, input, true);
    }
  } catch (dbErr: any) {
    const message = String(dbErr?.message || "");
    if (!message.includes("duration_ms")) throw dbErr;
    const updated = await env.DB.prepare(
      `
      UPDATE recordings
      SET r2_key = ?, status = ?, processing_stage = ?, style_profile_id = COALESCE(?, style_profile_id), style_profile_version = COALESCE(?, style_profile_version), layout_profile_id = COALESCE(?, layout_profile_id), layout_profile_version = COALESCE(?, layout_profile_version), error_message = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND filename = ?
      `,
    )
      .bind(
        input.key,
        "UPLOADED",
        "QUEUED",
        input.profileSelection.styleProfileId || null,
        input.profileSelection.styleProfileVersion || null,
        input.profileSelection.layoutProfileId || null,
        input.profileSelection.layoutProfileVersion || null,
        auth.userId,
        input.filename,
      )
      .run();

    if ((updated.meta.changes ?? 0) === 0) {
      await insertUploadedRecording(env, auth, input, false);
    }
  }
  await ensureEditorialRecordingScope(env, auth, input.filename);
}

async function insertUploadedRecording(
  env: Env,
  auth: AuthContext,
  input: {
    filename: string;
    key: string;
    durationMs: number | null;
    profileSelection: WritingProfileSelection;
  },
  includeDuration: boolean,
): Promise<void> {
  const durationColumns = includeDuration ? ", duration_ms" : "";
  const durationValues = includeDuration ? ", ?" : "";
  const values: unknown[] = [
    auth.userId,
    auth.workspaceId,
    input.filename,
    input.key,
    "UPLOADED",
    "QUEUED",
  ];
  if (includeDuration) values.push(input.durationMs);
  values.push(
    input.profileSelection.styleProfileId || null,
    input.profileSelection.styleProfileVersion || null,
    input.profileSelection.layoutProfileId || null,
    input.profileSelection.layoutProfileVersion || null,
  );
  try {
    await env.DB.prepare(
      `INSERT INTO recordings (user_id, workspace_id, filename, r2_key, status, processing_stage${durationColumns}, style_profile_id, style_profile_version, layout_profile_id, layout_profile_version)
       VALUES (?, ?, ?, ?, ?, ?${durationValues}, ?, ?, ?, ?)`,
    ).bind(...values).run();
  } catch (error) {
    if (!String((error as any)?.message || error).includes("workspace_id")) throw error;
    const legacyValues: unknown[] = [auth.userId, input.filename, input.key, "UPLOADED", "QUEUED"];
    if (includeDuration) legacyValues.push(input.durationMs);
    legacyValues.push(
      input.profileSelection.styleProfileId || null,
      input.profileSelection.styleProfileVersion || null,
      input.profileSelection.layoutProfileId || null,
      input.profileSelection.layoutProfileVersion || null,
    );
    await env.DB.prepare(
      `INSERT INTO recordings (user_id, filename, r2_key, status, processing_stage${durationColumns}, style_profile_id, style_profile_version, layout_profile_id, layout_profile_version)
       VALUES (?, ?, ?, ?, ?${includeDuration ? ", ?" : ""}, ?, ?, ?, ?)`,
    ).bind(...legacyValues).run();
  }
}

async function ensureEditorialRecordingScope(env: Env, auth: AuthContext, filename: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO editorial_recording_scopes (recording_id, user_id, workspace_id)
       SELECT id, ?, ? FROM recordings WHERE user_id = ? AND filename = ?`,
    ).bind(auth.userId, auth.workspaceId, auth.userId, filename).run();
  } catch (error) {
    // Old Worker databases can accept uploads before the additive editorial migration is applied.
    console.warn("Editorial recording scope backfill deferred:", error instanceof Error ? error.message : String(error));
  }
}

async function triggerGitHubAction(
  env: Env,
  input: { targetFilename: string; targetKey?: string; userId?: string; revisionRequestKey?: string },
): Promise<void> {
  if (!env.GITHUB_PAT) {
    console.warn("GITHUB_PAT is not configured. Skipping immediate GitHub Action trigger.");
    return;
  }

  const repo = "litianc/vibepub-android";
  const workflowId = "mining-job.yml";
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflowId}/dispatches`;
  const workflowRef = env.GITHUB_WORKFLOW_REF?.trim() || "main";

  const inputs: Record<string, string> = {
    target_filename: input.targetFilename,
  };
  if (input.targetKey) inputs.target_key = input.targetKey;
  if (input.userId) inputs.user_id = input.userId;
  if (input.revisionRequestKey) inputs.revision_request_key = input.revisionRequestKey;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "Authorization": `token ${env.GITHUB_PAT}`,
      "User-Agent": "VibePub-Cloudflare-Worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref: workflowRef,
      inputs,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API returned ${response.status}: ${errorText}`);
  }
}

function isRecordingRevisionPath(pathname: string): boolean {
  return pathname.startsWith("/api/recordings/") && pathname.endsWith("/revisions");
}

function recordingFilenameForSubresource(pathname: string, suffix: string): string | null {
  const prefix = "/api/recordings/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const encoded = pathname.slice(prefix.length, -suffix.length);
  if (!encoded) return null;
  return safeDecodeURIComponent(encoded);
}

function staleArticleVersionResponse(): Response {
  return json({
    error: "stale_article_version",
    message: "文章已有新版本，请刷新后再选择",
  }, 409);
}

async function getArticleFeedback(env: Env, auth: AuthContext, filename: string): Promise<Response> {
  const recording = await articleFeedbackRecording(env, auth, filename);
  if (!recording) return json({ error: "recording_not_found" }, 404);

  const versions = await articleFeedbackVersions(env, auth, recording.id);
  const currentVersion = versions[0] || null;
  const hasNoArticleVersion = currentVersion === null;
  const feedback = await queryAll<Record<string, unknown>>(
    env,
    `SELECT server_sequence, id, version_id, action, client_event_id, occurred_at, created_at
     FROM article_feedback_events
     WHERE user_id = ? AND workspace_id = ? AND recording_id = ?
     ORDER BY server_sequence ASC`,
    [auth.userId, auth.workspaceId, recording.id],
  );
  const currentFeedback = currentVersion
    ? [...feedback].reverse().find((event) => event.version_id === currentVersion.id) || null
    : null;

  return json({
    recording_id: recording.id,
    legacy: hasNoArticleVersion,
    current_version: currentVersion
      ? { id: currentVersion.id, version_no: Number(currentVersion.version_no) }
      : null,
    current_feedback: currentFeedback ? publicArticleFeedback(currentFeedback) : null,
    feedback: feedback.map(publicArticleFeedback),
  });
}

async function createArticleFeedback(
  request: Request,
  env: Env,
  auth: AuthContext,
  filename: string,
): Promise<Response> {
  const body = await parseJson(request);
  const versionId = normalizeOptionalString(body?.version_id ?? body?.versionId);
  const action = normalizeArticleFeedbackAction(body?.action);
  const clientEventId = normalizeOptionalString(body?.client_event_id ?? body?.clientEventId);
  if (!versionId || !action || !clientEventId || clientEventId.length > 200) {
    return json({ error: "invalid_article_feedback" }, 400);
  }

  const recording = await articleFeedbackRecording(env, auth, filename);
  if (!recording) return json({ error: "recording_not_found" }, 404);

  const payloadHash = await sha256Hex(JSON.stringify({
    version_id: versionId,
    action,
  }));
  const existing = await articleFeedbackByClientEvent(env, auth, clientEventId);
  if (existing) {
    if (!articleFeedbackMatches(existing, {
      recordingId: recording.id,
      versionId,
      action,
      payloadHash,
    })) {
      return json({ error: "idempotency_conflict" }, 409);
    }
    return json({ ok: true, idempotent: true, feedback: publicArticleFeedback(existing) });
  }

  const versions = await articleFeedbackVersions(env, auth, recording.id);
  const requestedVersion = versions.find((version) => version.id === versionId);
  if (!requestedVersion) return json({ error: "article_version_not_found" }, 404);
  if (versions[0]?.id !== versionId) {
    return staleArticleVersionResponse();
  }

  const feedbackId = `feedback_${crypto.randomUUID()}`;
  const occurredAt = nowIso();
  const inserted = await env.DB.prepare(
    `INSERT INTO article_feedback_events
      (id, user_id, workspace_id, article_id, recording_id, version_id, action,
       client_event_id, payload_hash, occurred_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE ? = (
       SELECT id FROM article_versions
       WHERE user_id = ? AND workspace_id = ? AND recording_id = ?
       ORDER BY version_no DESC LIMIT 1
     )
     ON CONFLICT(user_id, workspace_id, client_event_id) DO NOTHING`,
  ).bind(
    feedbackId,
    auth.userId,
    auth.workspaceId,
    requestedVersion.article_id,
    recording.id,
    versionId,
    action,
    clientEventId,
    payloadHash,
    occurredAt,
    versionId,
    auth.userId,
    auth.workspaceId,
    recording.id,
  ).run();

  const stored = await articleFeedbackByClientEvent(env, auth, clientEventId);
  if (!stored) {
    const latestVersions = await articleFeedbackVersions(env, auth, recording.id);
    if (latestVersions[0]?.id !== versionId) {
      return staleArticleVersionResponse();
    }
    return json({ error: "article_feedback_write_unavailable" }, 503);
  }
  if (!articleFeedbackMatches(stored, {
    recordingId: recording.id,
    versionId,
    action,
    payloadHash,
  })) {
    return json({ error: "idempotency_conflict" }, 409);
  }
  return json({
    ok: true,
    idempotent: (inserted.meta.changes ?? 0) === 0,
    feedback: publicArticleFeedback(stored),
  }, (inserted.meta.changes ?? 0) === 0 ? 200 : 201);
}

async function articleFeedbackRecording(
  env: Env,
  auth: AuthContext,
  filename: string,
): Promise<{ id: number } | null> {
  const safeName = sanitizeFileName(filename);
  if (!safeName) return null;
  return queryOne<{ id: number }>(
    env,
    `SELECT id FROM recordings WHERE user_id = ? AND filename = ? LIMIT 1`,
    [auth.userId, safeName],
  );
}

async function articleFeedbackVersions(
  env: Env,
  auth: AuthContext,
  recordingId: number,
): Promise<Array<{ id: string; article_id: string; version_no: number }>> {
  return queryAll(
    env,
    `SELECT id, article_id, version_no FROM article_versions
     WHERE user_id = ? AND workspace_id = ? AND recording_id = ?
     ORDER BY version_no DESC`,
    [auth.userId, auth.workspaceId, recordingId],
  );
}

async function articleFeedbackByClientEvent(
  env: Env,
  auth: AuthContext,
  clientEventId: string,
): Promise<Record<string, unknown> | null> {
  return queryOne(
    env,
    `SELECT server_sequence, id, user_id, workspace_id, article_id, recording_id,
        version_id, action, client_event_id, payload_hash, occurred_at, created_at
     FROM article_feedback_events
     WHERE user_id = ? AND workspace_id = ? AND client_event_id = ? LIMIT 1`,
    [auth.userId, auth.workspaceId, clientEventId],
  );
}

function normalizeArticleFeedbackAction(value: unknown): ArticleFeedbackAction | null {
  return value === "adopted" || value === "not_adopted" ? value : null;
}

function articleFeedbackMatches(
  row: Record<string, unknown>,
  identity: ArticleFeedbackIdentity,
): boolean {
  return Number(row.recording_id) === identity.recordingId &&
    row.version_id === identity.versionId &&
    row.action === identity.action &&
    row.payload_hash === identity.payloadHash;
}

function publicArticleFeedback(row: Record<string, unknown>): Record<string, unknown> {
  return {
    server_sequence: Number(row.server_sequence),
    id: row.id,
    version_id: row.version_id,
    action: row.action,
    client_event_id: row.client_event_id,
    occurred_at: row.occurred_at,
    created_at: row.created_at,
  };
}

async function createArticleRevision(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  auth: AuthContext,
  filename: string,
): Promise<Response> {
  if (!request.body) {
    return json({ error: "missing_body" }, 400);
  }

  const safeName = sanitizeFileName(filename);
  if (!safeName) {
    return json({ error: "missing_filename" }, 400);
  }

  const latest = await queryOne<{
    recording_id: number;
    id: string;
    article_id: string;
    version_no: number;
    title: string;
    body: string;
  }>(env, `SELECT r.id AS recording_id, v.id, v.article_id, v.version_no, v.title, v.body
    FROM recordings r
    JOIN editorial_recording_scopes s ON s.recording_id = r.id AND s.user_id = r.user_id
    JOIN article_versions v ON v.recording_id = r.id
      AND v.user_id = r.user_id AND v.workspace_id = s.workspace_id
    WHERE r.user_id = ? AND s.workspace_id = ? AND r.filename = ?
    ORDER BY v.version_no DESC LIMIT 1`, [auth.userId, auth.workspaceId, safeName]);
  if (!latest) return json({ error: "article_version_not_found" }, 409);

  const explicitParentId = normalizeOptionalString(request.headers.get("X-Article-Version-Id"));
  const clientRequestId = normalizeOptionalString(request.headers.get("X-Revision-Request-Id")) || `legacy_${crypto.randomUUID()}`;
  if (clientRequestId.length > 200) return json({ error: "invalid_revision_request_id" }, 400);

  const audioBytes = new Uint8Array(await request.arrayBuffer());
  const audioContentSha256 = `sha256:${await sha256Bytes(audioBytes)}`;
  const audioSha256 = normalizeOptionalString(request.headers.get("X-Revision-Audio-Sha256"))
    || audioContentSha256;
  const existing = await articleRevisionRequestByClient(env, auth, clientRequestId);
  const feedbackId = normalizeOptionalString(request.headers.get("X-Revision-Feedback-Id"))
    || normalizeOptionalString(existing?.feedback_id)
    || `feedback_${crypto.randomUUID()}`;
  if (feedbackId.length > 200) return json({ error: "invalid_revision_feedback_id" }, 400);
  const requestedParentId = explicitParentId || String(existing?.parent_version_id || latest.id);
  const payloadHash = await sha256Hex(JSON.stringify({
    recording_id: latest.recording_id,
    parent_version_id: requestedParentId,
    feedback_id: feedbackId,
    audio_sha256: audioSha256,
    audio_content_sha256: audioContentSha256,
  }));
  if (existing) {
    if (!articleRevisionRequestMatches(existing, {
      recordingId: latest.recording_id, parentVersionId: requestedParentId,
      feedbackId, payloadHash, audioSha256,
    })) {
      return json({ error: "idempotency_conflict" }, 409);
    }
    if (existing.status === "queued" || existing.status === "wechat_failed") {
      const replayParent = existing.parent_version_id === latest.id
        ? latest
        : await articleRevisionParent(env, auth, latest.recording_id, String(existing.parent_version_id));
      if (!replayParent) return json({ error: "revision_parent_not_found" }, 409);
      await persistArticleRevisionArtifacts(env, auth, safeName, replayParent, existing, audioBytes, request.headers.get("content-type"));
      dispatchArticleRevision(ctx, env, auth.userId, safeName, String(existing.request_key));
    }
    return articleRevisionResponse(existing, true);
  }
  if (requestedParentId !== latest.id) return staleArticleVersionResponse();

  const transcriptKey = userScopedKey(auth.userId, "transcripts", safeName.replace(/\.[^/.]+$/, ".json"));
  const transcriptObject = await env.FILES_BUCKET.get(transcriptKey);
  if (!transcriptObject) {
    return json({
      error: "article_not_ready",
      message: "文章结果尚未生成，暂不能提交语音修改",
    }, 409);
  }

  const revisionId = `revision_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const baseName = safeName.replace(/\.[^/.]+$/, "");
  const audioKey = userScopedKey(auth.userId, "revision-requests", `${baseName}/${revisionId}.m4a`);
  const revisionRequestKey = userScopedKey(auth.userId, "revision-requests", `${baseName}/${revisionId}.json`);
  const row = {
    id: revisionId, user_id: auth.userId, workspace_id: auth.workspaceId,
    article_id: latest.article_id, recording_id: latest.recording_id,
    parent_version_id: latest.id, feedback_id: feedbackId,
    client_request_id: clientRequestId, payload_hash: payloadHash,
    audio_sha256: audioSha256, audio_key: audioKey, request_key: revisionRequestKey,
    transcript_key: transcriptKey, status: "queued", child_version_id: null,
    error_message: null, created_at: createdAt, updated_at: createdAt,
  };
  try {
    const inserted = await env.DB.prepare(`INSERT INTO article_revision_requests
      (id, user_id, workspace_id, article_id, recording_id, parent_version_id,
       feedback_id, client_request_id, payload_hash, audio_sha256, audio_key, request_key, transcript_key,
       status, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM article_versions WHERE parent_version_id = ?
      )`)
      .bind(revisionId, auth.userId, auth.workspaceId, latest.article_id, latest.recording_id,
        latest.id, feedbackId, clientRequestId, payloadHash, audioSha256, audioKey, revisionRequestKey,
        transcriptKey, "queued", createdAt, createdAt, latest.id).run();
    if ((inserted.meta.changes ?? 0) === 0) return staleArticleVersionResponse();
  } catch {
    const raced = await articleRevisionRequestByClient(env, auth, clientRequestId);
    if (raced && articleRevisionRequestMatches(raced, {
      recordingId: latest.recording_id, parentVersionId: requestedParentId,
      feedbackId, payloadHash, audioSha256,
    })) return articleRevisionResponse(raced, true);
    const owner = await articleRevisionRequestByParent(env, auth, latest.id);
    if (owner) return json({ error: "revision_parent_conflict" }, 409);
    return json({ error: "article_revision_write_unavailable" }, 503);
  }

  await persistArticleRevisionArtifacts(env, auth, safeName, latest, row, audioBytes, request.headers.get("content-type"));

  await markRecordingRevisionQueued(env, auth.userId, safeName);
  dispatchArticleRevision(ctx, env, auth.userId, safeName, revisionRequestKey);
  return articleRevisionResponse(row, false);
}

async function articleRevisionRequestByClient(env: Env, auth: AuthContext, clientRequestId: string): Promise<any | null> {
  return queryOne(env, `SELECT * FROM article_revision_requests
    WHERE user_id = ? AND workspace_id = ? AND client_request_id = ? LIMIT 1`,
  [auth.userId, auth.workspaceId, clientRequestId]);
}

function articleRevisionRequestMatches(
  row: any,
  identity: { recordingId: number; parentVersionId: string; feedbackId: string; payloadHash: string; audioSha256: string },
): boolean {
  return Number(row.recording_id) === identity.recordingId &&
    row.parent_version_id === identity.parentVersionId &&
    row.feedback_id === identity.feedbackId &&
    row.payload_hash === identity.payloadHash &&
    row.audio_sha256 === identity.audioSha256;
}

async function articleRevisionRequestByParent(env: Env, auth: AuthContext, parentVersionId: string): Promise<any | null> {
  return queryOne(env, `SELECT * FROM article_revision_requests
    WHERE user_id = ? AND workspace_id = ? AND parent_version_id = ? LIMIT 1`,
  [auth.userId, auth.workspaceId, parentVersionId]);
}

async function articleRevisionParent(
  env: Env,
  auth: AuthContext,
  recordingId: number,
  parentVersionId: string,
): Promise<any | null> {
  return queryOne(env, `SELECT id, article_id, recording_id, version_no, title, body
    FROM article_versions WHERE id = ? AND user_id = ? AND workspace_id = ? AND recording_id = ? LIMIT 1`,
  [parentVersionId, auth.userId, auth.workspaceId, recordingId]);
}

async function persistArticleRevisionArtifacts(
  env: Env,
  auth: AuthContext,
  filename: string,
  parent: { id: string; article_id: string; recording_id: number; title: string; body: string },
  row: any,
  audioBytes: Uint8Array,
  contentType: string | null,
): Promise<void> {
  const metadata = {
    filename, revisionId: String(row.id), userId: auth.userId,
    workspaceId: auth.workspaceId, createdAt: String(row.created_at),
  };
  await env.FILES_BUCKET.put(String(row.audio_key), audioBytes, {
    httpMetadata: { contentType: contentType || "audio/mp4" }, customMetadata: metadata,
  });
  const contract = {
    revisionId: row.id,
    clientRequestId: row.client_request_id,
    filename,
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    recordingId: parent.recording_id,
    articleId: parent.article_id,
    parentVersionId: parent.id,
    parentTitle: parent.title,
    parentContent: parent.body,
    transcriptKey: row.transcript_key,
    audioKey: row.audio_key,
    audioSha256: row.audio_sha256,
    feedbackId: row.feedback_id,
    createdAt: row.created_at,
  };
  await env.FILES_BUCKET.put(String(row.request_key), JSON.stringify(contract, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }, customMetadata: metadata,
  });
}

function dispatchArticleRevision(
  ctx: ExecutionContext,
  env: Env,
  userId: string,
  filename: string,
  revisionRequestKey: string,
): void {
  ctx.waitUntil(triggerGitHubAction(env, {
    targetFilename: filename, userId, revisionRequestKey,
  }).catch((error) => console.error("Failed to trigger GitHub Action for article revision:", error)));
}

function articleRevisionResponse(row: any, replayed: boolean): Response {
  return json({
    ok: true,
    revision_id: row.id,
    parent_version_id: row.parent_version_id,
    continue_revision: { accepted: true, parent_version_id: row.parent_version_id },
    feedback: { id: row.feedback_id, version_id: row.parent_version_id, action: "continue_revision" },
    status: row.status,
    replayed,
    revision_request_key: row.request_key,
  }, 202);
}

async function handleArticleRevisionInternal(
  request: Request,
  env: Env,
  revisionId: string,
  action: "version" | "status",
): Promise<Response> {
  const body = await parseJson(request);
  return action === "version"
    ? createArticleRevisionVersion(env, revisionId, body)
    : updateArticleRevisionStatus(env, revisionId, body);
}

async function createArticleRevisionVersion(env: Env, revisionId: string, body: any): Promise<Response> {
  const title = normalizeOptionalString(body?.title);
  const content = normalizeOptionalString(body?.body ?? body?.content);
  if (!title || !content) return json({ error: "invalid_revision_version" }, 400);

  const request = await queryOne<any>(env, `SELECT rr.*,
      p.version_no AS parent_version_no, p.title AS parent_title, p.body AS parent_body,
      p.cover_json AS parent_cover_json, p.cover_title_json AS parent_cover_title_json,
      p.formatting_skill_id AS parent_formatting_skill_id,
      p.formatting_skill_version AS parent_formatting_skill_version
    FROM article_revision_requests rr
    JOIN article_versions p ON p.id = rr.parent_version_id
      AND p.user_id = rr.user_id AND p.workspace_id = rr.workspace_id
      AND p.article_id = rr.article_id AND p.recording_id = rr.recording_id
    WHERE rr.id = ? LIMIT 1`, [revisionId]);
  if (!request) return json({ error: "revision_not_found" }, 404);

  const cover = body?.cover ?? body?.cover_metadata ?? null;
  const preparedArtifactKey = normalizeOptionalString(body?.prepared_artifact_key ?? body?.preparedArtifactKey);
  const versionPayloadHash = await sha256Hex(JSON.stringify({
    title, body: content, cover, prepared_artifact_key: preparedArtifactKey,
  }));
  const existingChild = await articleRevisionChild(env, request.parent_version_id);
  if (existingChild) {
    if (!articleRevisionChildMatches(existingChild, revisionId, versionPayloadHash)) {
      return json({ error: "revision_version_conflict" }, 409);
    }
    await ensureArticleRevisionProjection(env, request, existingChild, title, content);
    return articleRevisionVersionResponse(existingChild, true, 200);
  }

  const latest = await queryOne<{ id: string }>(env, `SELECT id FROM article_versions
    WHERE user_id = ? AND workspace_id = ? AND article_id = ? AND recording_id = ?
    ORDER BY version_no DESC LIMIT 1`,
  [request.user_id, request.workspace_id, request.article_id, request.recording_id]);
  if (!latest || latest.id !== request.parent_version_id) {
    return json({ error: "stale_article_version" }, 409);
  }

  const childId = `av_revision_${await sha256Hex(revisionId)}`;
  const createdAt = nowIso();
  const coverJson = cover === null ? String(request.parent_cover_json || "{}") : JSON.stringify(cover);
  const blocksJson = JSON.stringify([{
    block_id: "block_1",
    kind: "paragraph",
    order: 0,
    text: content,
    claim_ids: [],
    image_ids: [],
  }]);
  const contentHtmlHash = `sha256:${await sha256Hex(content)}`;
  const child = {
    id: childId,
    version_no: Number(request.parent_version_no) + 1,
    parent_version_id: request.parent_version_id,
    source_job_id: revisionId,
    payload_hash: versionPayloadHash,
  };
  const versionInsert = env.DB.prepare(`INSERT INTO article_versions
    (id, user_id, workspace_id, article_id, recording_id, version_no, parent_version_id,
     source, source_job_id, source_hash, title, body, cover_json, blocks_json,
     title_candidates_json, selected_title, cover_title_json, claim_ledger_json,
     visual_plan_json, formatting_skill_id, formatting_skill_version, content_html_hash,
     html_warnings_json, generation_status, idempotency_key, payload_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'revision', ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]',
      ?, ?, ?, '[]', 'frozen', ?, ?, ?)`)
    .bind(childId, request.user_id, request.workspace_id, request.article_id, request.recording_id,
      child.version_no, request.parent_version_id, revisionId, request.audio_sha256, title, content,
      coverJson, blocksJson, JSON.stringify([title]), title, String(request.parent_cover_title_json || "[]"),
      request.parent_formatting_skill_id, request.parent_formatting_skill_version,
      contentHtmlHash, `continue_revision:${revisionId}`, versionPayloadHash, createdAt);
  const stateInsert = env.DB.prepare(`INSERT INTO editorial_version_states
    (version_id, user_id, workspace_id, article_id, recording_id, state, state_revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'content_frozen', 0, ?, ?)`)
    .bind(childId, request.user_id, request.workspace_id, request.article_id,
      request.recording_id, createdAt, createdAt);
  const requestUpdate = env.DB.prepare(`UPDATE article_revision_requests
    SET child_version_id = ?, status = 'wechat_pending', error_message = NULL, updated_at = ?
    WHERE id = ? AND child_version_id IS NULL`)
    .bind(childId, createdAt, revisionId);
  const recordingUpdate = env.DB.prepare(`UPDATE recordings
    SET article_title = ?, article_content = ?, status = 'PROCESSING',
      processing_stage = 'PUBLISHING', error_message = NULL, updated_at = ?
    WHERE id = ? AND user_id = ? AND EXISTS (
      SELECT 1 FROM editorial_recording_scopes s
      WHERE s.recording_id = recordings.id AND s.user_id = recordings.user_id AND s.workspace_id = ?
    )`)
    .bind(title, content, createdAt, request.recording_id, request.user_id, request.workspace_id);
  try {
    await env.DB.batch([versionInsert, stateInsert, requestUpdate, recordingUpdate]);
  } catch {
    const raced = await articleRevisionChild(env, request.parent_version_id);
    if (!raced) return json({ error: "revision_version_write_unavailable" }, 503);
    if (!articleRevisionChildMatches(raced, revisionId, versionPayloadHash)) {
      return json({ error: "revision_version_conflict" }, 409);
    }
    await ensureArticleRevisionProjection(env, request, raced, title, content);
    return articleRevisionVersionResponse(raced, true, 200);
  }
  return articleRevisionVersionResponse(child, false, 201);
}

async function articleRevisionChild(env: Env, parentVersionId: string): Promise<any | null> {
  return queryOne(env, `SELECT id, version_no, parent_version_id, source_job_id, payload_hash
    FROM article_versions WHERE parent_version_id = ? LIMIT 1`, [parentVersionId]);
}

function articleRevisionChildMatches(child: any, revisionId: string, payloadHash: string): boolean {
  return child.source_job_id === revisionId && child.payload_hash === payloadHash;
}

async function ensureArticleRevisionProjection(
  env: Env,
  request: any,
  child: any,
  title: string,
  content: string,
): Promise<void> {
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(`UPDATE article_revision_requests
      SET child_version_id = ?, status = CASE WHEN status = 'queued' THEN 'wechat_pending' ELSE status END,
        updated_at = ? WHERE id = ?`).bind(child.id, now, request.id),
    env.DB.prepare(`UPDATE recordings SET article_title = ?, article_content = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND EXISTS (
        SELECT 1 FROM editorial_recording_scopes s
        WHERE s.recording_id = recordings.id AND s.user_id = recordings.user_id AND s.workspace_id = ?
      )
        AND ? = (SELECT id FROM article_versions
          WHERE user_id = ? AND workspace_id = ? AND article_id = ? AND recording_id = ?
          ORDER BY version_no DESC LIMIT 1)`)
      .bind(title, content, now, request.recording_id, request.user_id, request.workspace_id,
        child.id, request.user_id, request.workspace_id, request.article_id, request.recording_id),
  ]);
}

function articleRevisionVersionResponse(child: any, replayed: boolean, status: number): Response {
  return json({
    child_version_id: child.id,
    version_no: Number(child.version_no),
    parent_version_id: child.parent_version_id,
    version: {
      id: child.id,
      version_no: Number(child.version_no),
      parent_version_id: child.parent_version_id,
    },
    replayed,
  }, status);
}

async function updateArticleRevisionStatus(env: Env, revisionId: string, body: any): Promise<Response> {
  const status = normalizeOptionalString(body?.status);
  if (status !== "wechat_pending" && status !== "completed" && status !== "wechat_failed") {
    return json({ error: "invalid_revision_status" }, 400);
  }
  const errorMessage = normalizeOptionalString(body?.error_message ?? body?.errorMessage);
  const row = await queryOne<any>(env, `SELECT * FROM article_revision_requests WHERE id = ? LIMIT 1`, [revisionId]);
  if (!row) return json({ error: "revision_not_found" }, 404);
  if (!row.child_version_id) return json({ error: "revision_version_required" }, 409);
  const normalizedError = status === "wechat_failed" ? errorMessage : null;
  if (row.status === "completed" && status !== "completed") {
    return json({
      revision_id: row.id,
      child_version_id: row.child_version_id,
      status: row.status,
      replayed: true,
    });
  }
  if (row.status === status && (row.error_message || null) === normalizedError) {
    return json({ revision_id: row.id, child_version_id: row.child_version_id, status, replayed: true });
  }
  await env.DB.prepare(`UPDATE article_revision_requests
    SET status = ?, error_message = ?, updated_at = ? WHERE id = ?`)
    .bind(status, normalizedError, nowIso(), revisionId).run();
  return json({ revision_id: row.id, child_version_id: row.child_version_id, status, replayed: false });
}

async function markRecordingRevisionQueued(env: Env, userId: string, filename: string): Promise<void> {
  await env.DB.prepare(
    `
    UPDATE recordings
    SET status = ?, processing_stage = ?, error_message = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND filename = ?
    `,
  )
    .bind("PROCESSING", "REWRITING", userId, filename)
    .run();
}

async function listUploads(env: Env, url: URL, auth: AuthContext): Promise<Response> {
  const limit = clamp(Number(url.searchParams.get("limit") || "25"), 1, 100);
  const listed = await env.FILES_BUCKET.list({
    prefix: userScopedPrefix(auth.userId, "inbox"),
    limit,
  });

  return json({
    objects: listed.objects.map((object) => ({
      key: object.key,
      size: object.size,
      uploaded: object.uploaded.toISOString(),
      httpEtag: object.httpEtag,
      checksums: object.checksums,
      customMetadata: object.customMetadata,
    })),
  });
}

async function listRecordings(env: Env, auth: AuthContext): Promise<Response> {
  try {
    const recordings = await queryRecordings(env, auth.userId);
    const projected = publicationFeatureEnabled(env, auth.userId, auth.workspaceId)
      ? await enrichRecordingList(env.DB, auth, recordings)
      : recordings;
    return json({ recordings: withRecordingDisplayFields(projected) });
  } catch (dbErr: any) {
    console.error("Failed to fetch from D1:", dbErr);
    return json({ error: "database_error", details: dbErr.message }, 500);
  }
}

async function retryPublicationWritingAfterServiceFix(
  env: Env,
  auth: AuthContext,
  runId: string,
  idempotencyKey: string,
  payloadHash: string,
  expectedStateRevision: number,
): Promise<Record<string, unknown>> {
  const candidate = await env.DB.prepare(`SELECT p.state, p.error_code, p.next_action,
      EXISTS(SELECT 1 FROM publication_run_events e
        WHERE e.run_id = p.run_id AND e.user_id = p.user_id AND e.workspace_id = p.workspace_id
          AND e.event_type = 'revision_requested') AS has_revision_requested
    FROM publication_runs p WHERE p.run_id = ? AND p.user_id = ? AND p.workspace_id = ? LIMIT 1`)
    .bind(runId, auth.userId, auth.workspaceId)
    .first<{ state: string; error_code: string | null; next_action: string | null; has_revision_requested: number }>();
  if (
    candidate?.state === "failed" &&
    candidate.error_code === "writing_adapter_non_retryable" &&
    candidate.next_action === "retry_after_service_fix" &&
    Number(candidate.has_revision_requested) !== 0
  ) {
    throw new PublicationProjectionError(
      "publication_writing_retry_round_not_supported",
      "only the initial writing round can be restarted after a writing service fix",
      409,
    );
  }
  const retried = await assertPublicationAction(
    env.DB,
    auth,
    runId,
    "retry",
    idempotencyKey,
    payloadHash,
    expectedStateRevision,
  );
  const retryRun = retried.run as Record<string, unknown> | undefined;
  const retryRevision = Number(retryRun?.state_revision);
  if (
    retryRun?.state !== "retrying" ||
    retryRun.last_successful_state !== "writing" ||
    !Number.isSafeInteger(retryRevision) ||
    retryRevision < 1
  ) {
    return retried;
  }

  const failureEvidence = await env.DB.prepare(`SELECT state, error_code, next_action
    FROM publication_run_events
    WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND revision = ?
    LIMIT 1`)
    .bind(runId, auth.userId, auth.workspaceId, retryRevision - 1)
    .first<{ state: string; error_code: string | null; next_action: string | null }>();
  if (
    failureEvidence?.state !== "failed" ||
    failureEvidence.error_code !== "writing_adapter_non_retryable" ||
    failureEvidence.next_action !== "retry_after_service_fix"
  ) {
    return retried;
  }
  const retryScope = await env.DB.prepare(`SELECT EXISTS(SELECT 1 FROM publication_run_events
      WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND event_type = 'revision_requested') AS has_revision_requested`)
    .bind(runId, auth.userId, auth.workspaceId)
    .first<{ has_revision_requested: number }>();
  if (!retryScope || Number(retryScope.has_revision_requested) !== 0) {
    throw new PublicationProjectionError(
      "publication_writing_retry_round_not_supported",
      "only the initial writing round can be restarted after a writing service fix",
      409,
    );
  }
  const retryEvidence = await env.DB.prepare(`SELECT event_type, state, retry_count, payload_hash, created_at
    FROM publication_run_events
    WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND revision = ?
    LIMIT 1`)
    .bind(runId, auth.userId, auth.workspaceId, retryRevision)
    .first<{ event_type: string; state: string; retry_count: number; payload_hash: string; created_at: string }>();
  if (
    retryEvidence?.event_type !== "action_retry" ||
    retryEvidence.state !== "retrying" ||
    Number(retryEvidence.retry_count) !== Number(retryRun.retry_count) ||
    retryEvidence.payload_hash !== payloadHash ||
    !Number.isFinite(Date.parse(retryEvidence.created_at))
  ) {
    throw new PublicationProjectionError(
      "publication_writing_retry_evidence_invalid",
      "writing retry evidence does not reconcile",
      409,
    );
  }

  const resumeKey = `auto-resume:${await sha256Hex(JSON.stringify({
    run_id: runId,
    retry_idempotency_key: idempotencyKey,
    retry_revision: retryRevision,
  }))}`;
  const resumePayloadHash = `sha256:${await sha256Hex(JSON.stringify({
    action: "resume",
    expected_state_revision: retryRevision,
    contract: "system.v1",
    cause: "writing_service_fix_retry",
  }))}`;
  const resumed = await resumePublicationRun(
    env.DB,
    auth,
    runId,
    resumeKey,
    resumePayloadHash,
    retryRevision,
  );
  const resumedRun = resumed.run as Record<string, unknown> | undefined;
  if (
    resumedRun?.state !== "writing" ||
    Number(resumedRun.state_revision) !== retryRevision + 1 ||
    Number(resumedRun.retry_count) !== Number(retryRun.retry_count)
  ) {
    throw new PublicationProjectionError(
      "publication_writing_retry_state_invalid",
      "writing retry did not resume the expected publication state",
      409,
    );
  }
  const articleId = String(resumedRun.article_id || "");
  if (!articleId) {
    throw new PublicationProjectionError("publication_writing_retry_state_invalid", "writing retry article is unavailable", 409);
  }
  const workflowId = `five-agent-${runId}`;
  const coordinator = env.EDITORIAL_COORDINATOR.getByName(
    await coordinatorShardName(auth.userId, auth.workspaceId, articleId, runId),
  );
  const receiptInput = {
    run_id: runId,
    user_id: auth.userId,
    workspace_id: auth.workspaceId,
    workflow_id: workflowId,
    retry_event_revision: retryRevision,
    retry_count: Number(retryRun.retry_count),
    payload_hash: payloadHash,
  };
  const receipt = await coordinator.getFiveAgentWritingRestartReceipt(receiptInput);
  const currentResult = await getPublicationRun(env.DB, auth, runId);
  const currentRun = currentResult.run as Record<string, unknown>;
  const writingRetryStillPending = currentRun.state === "writing" && Number(currentRun.state_revision) === retryRevision + 1;
  if (receipt.requested) {
    return {
      action: "retry",
      run: currentRun,
      replayed: true,
      workflow_restart_requested: true,
    };
  }
  if (!writingRetryStillPending) {
    await coordinator.recordFiveAgentWritingRestartReceipt({
      ...receiptInput,
      retry_created_at: retryEvidence.created_at,
      recorded_at: new Date().toISOString(),
    });
    return {
      action: "retry",
      run: currentRun,
      replayed: true,
      workflow_restart_requested: true,
    };
  }
  const recovery = await coordinator.startFiveAgentWritingRecovery({
    ...receiptInput,
    retry_event_revision: retryRevision,
    retry_created_at: retryEvidence.created_at,
  });
  if (!recovery.requested) {
    throw new PublicationProjectionError(
      "publication_workflow_restart_reconciliation_required",
      "writing workflow restart requires another reconciliation attempt",
      503,
    );
  }
  const latest = await getPublicationRun(env.DB, auth, runId);
  return {
    action: "retry",
    run: latest.run,
    replayed: Boolean(retried.replayed && resumed.replayed),
    workflow_restart_requested: true,
  };
}

async function publicationRoute(factory: () => Promise<Record<string, unknown>>): Promise<Response> {
  try {
    return json(redactPublicPublicationErrorCodes(await factory()));
  } catch (error) {
    if (error instanceof PublicationProjectionError) {
      return json({ error: error.code }, error.status);
    }
    console.error("Publication projection request failed:", error);
    return json({ error: "publication_projection_unavailable" }, 503);
  }
}

function redactPublicPublicationErrorCodes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPublicPublicationErrorCodes);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    key === "error_code" ? null : redactPublicPublicationErrorCodes(item),
  ]));
}

async function deleteRecording(env: Env, auth: AuthContext, filename: string): Promise<Response> {
  const safeName = sanitizeFileName(filename);
  if (!safeName) {
    return json({ error: "missing_filename" }, 400);
  }

  const r2Keys = new Set<string>();
  r2Keys.add(userScopedKey(auth.userId, "inbox", safeName));
  r2Keys.add(profileSelectionSidecarKey(auth.userId, safeName));
  if (inferSourceType(safeName, "") === "TEXT") {
    r2Keys.add(userScopedKey(auth.userId, "text-submissions", safeName));
  }
  r2Keys.add(userScopedKey(auth.userId, "transcripts", safeName.replace(/\.[^/.]+$/, ".json")));
  r2Keys.add(userScopedKey(auth.userId, "covers", safeName.replace(/\.[^/.]+$/, ".png")));

  const row = await queryOne<any>(
    env,
    `SELECT r2_key FROM recordings WHERE user_id = ? AND filename = ? LIMIT 1`,
    [auth.userId, safeName],
  );
  const r2Key = normalizeOptionalString(row?.r2_key);
  if (r2Key) {
    r2Keys.add(r2Key);
  }

  const deleted = await env.DB.prepare(
    `DELETE FROM recordings WHERE user_id = ? AND filename = ?`,
  )
    .bind(auth.userId, safeName)
    .run();

  const deletedFiles: string[] = [];
  const fileErrors: Array<{ key: string; message: string }> = [];
  for (const key of r2Keys) {
    try {
      await env.FILES_BUCKET.delete(key);
      deletedFiles.push(key);
    } catch (fileErr: any) {
      const message = String(fileErr?.message || fileErr);
      console.error(`Failed to delete R2 object ${key}:`, fileErr);
      fileErrors.push({ key, message });
    }
  }

  return json({
    ok: fileErrors.length === 0,
    filename: safeName,
    deleted_record_count: deleted.meta.changes ?? 0,
    deleted_files: deletedFiles,
    file_errors: fileErrors,
  }, fileErrors.length === 0 ? 200 : 207);
}

async function getPublishingAccount(env: Env, auth: AuthContext): Promise<Response> {
  const row = await queryOne<any>(
    env,
    `SELECT app_id, proxy_url, updated_at FROM publishing_accounts WHERE user_id = ? LIMIT 1`,
    [auth.userId],
  );
  return json({
    publishing_account: row
      ? {
          type: "wechat",
          app_id: row.app_id,
          proxy_url: row.proxy_url,
          connected: true,
          updated_at: row.updated_at,
        }
      : {
          type: "wechat",
          connected: false,
        },
  });
}

async function updatePublishingAccount(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const body = await parseJson(request);
  const appId = normalizeOptionalString(body?.app_id ?? body?.appId);
  const appSecret = normalizeOptionalString(body?.app_secret ?? body?.appSecret);
  const proxyUrl = normalizeOptionalString(body?.proxy_url ?? body?.proxyUrl);
  if (!appId) return json({ error: "missing_app_id" }, 400);
  const existing = await queryOne<any>(env, `SELECT app_secret_ciphertext FROM publishing_accounts WHERE user_id = ? LIMIT 1`, [auth.userId]);
  if (!existing && !appSecret) return json({ error: "missing_app_secret" }, 400);
  const encryptedSecret = appSecret ? await encryptSecret(env, appSecret) : existing.app_secret_ciphertext;
  const now = nowIso();

  await env.DB.prepare(
    `INSERT INTO publishing_accounts
      (user_id, type, app_id, app_secret_ciphertext, proxy_url, created_at, updated_at)
     VALUES (?, 'wechat', ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, type) DO UPDATE SET
       app_id = excluded.app_id,
       app_secret_ciphertext = excluded.app_secret_ciphertext,
       proxy_url = excluded.proxy_url,
       updated_at = excluded.updated_at`,
  )
    .bind(auth.userId, appId, encryptedSecret, proxyUrl, now, now)
    .run();

  return getPublishingAccount(env, auth);
}

async function getInternalPublishingAccount(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const userId = normalizeOptionalString(body?.user_id ?? body?.userId) || bootstrapAdminUserId(env);
  const row = await queryOne<any>(
    env,
    `SELECT app_id, app_secret_ciphertext, proxy_url, updated_at FROM publishing_accounts WHERE user_id = ? AND type = 'wechat' LIMIT 1`,
    [userId],
  );
  if (!row) {
    return json({ error: "publishing_account_not_configured" }, 404);
  }
  return json({
    publishing_account: {
      type: "wechat",
      app_id: row.app_id,
      app_secret: await decryptSecret(env, row.app_secret_ciphertext),
      proxy_url: row.proxy_url,
      updated_at: row.updated_at,
    },
  });
}

function withRecordingDisplayFields(recordings: unknown[]): unknown[] {
  return recordings.map((recording: any) => {
    const durationMs =
      nonNegativeIntegerOrNull(recording?.duration_ms) ??
      nonNegativeIntegerOrNull(recording?.durationMs) ??
      parseDurationMsFromRecordingFilename(recording?.filename);
    return {
      ...recording,
      duration_ms: durationMs,
      source_type: normalizeOptionalString(recording?.source_type) ??
        normalizeOptionalString(recording?.sourceType) ??
        inferSourceType(recording?.filename, recording?.r2_key),
      cover_image_url: normalizeOptionalString(recording?.cover_image_url) ??
        normalizeOptionalString(recording?.coverImageUrl),
      style_profile_id: normalizeOptionalString(recording?.style_profile_id) ??
        normalizeOptionalString(recording?.styleProfileId),
      style_profile_version: normalizeOptionalString(recording?.style_profile_version) ??
        normalizeOptionalString(recording?.styleProfileVersion),
      layout_profile_id: normalizeOptionalString(recording?.layout_profile_id) ??
        normalizeOptionalString(recording?.layoutProfileId),
      layout_profile_version: normalizeOptionalString(recording?.layout_profile_version) ??
        normalizeOptionalString(recording?.layoutProfileVersion),
      wechat_url: normalizeRemoteReference(recording?.wechat_url),
      wechat_draft_id: normalizeRemoteReference(recording?.wechat_draft_id),
    };
  });
}

function inferSourceType(filename: unknown, r2Key: unknown): string {
  const key = `${typeof r2Key === "string" ? r2Key : ""} ${typeof filename === "string" ? filename : ""}`.toLowerCase();
  if (key.includes("text-submissions/") || key.includes("-text-") || key.endsWith(".txt")) {
    return "TEXT";
  }
  if (key.includes("imported-audio")) {
    return "AUDIO_FILE";
  }
  return "RECORDING";
}

async function queryRecordings(env: Env, userId: string): Promise<unknown[]> {
  const options: RecordingQueryOptions = {
    includeUserIdFilter: true,
    includeDuration: true,
    includeProcessingStage: true,
    includeCoverImage: true,
    includeSourceType: true,
    includeStyleProfile: true,
    includeLayoutProfile: true,
  };

  for (let attempts = 0; attempts < 8; attempts += 1) {
    try {
      return await queryRecordingsWithOptions(env, userId, options);
    } catch (dbErr: any) {
      if (!relaxRecordingQueryOptions(options, String(dbErr?.message || ""))) {
        throw dbErr;
      }
    }
  }
  return queryRecordingsWithOptions(env, userId, options);
}

async function queryRecordingsWithOptions(
  env: Env,
  userId: string,
  options: RecordingQueryOptions,
): Promise<unknown[]> {
  const whereClause = options.includeUserIdFilter ? "WHERE user_id = ?" : "";
  const bindValues = options.includeUserIdFilter ? [userId] : [];
  const { results } = await env.DB.prepare(
    `
    SELECT
      id,
      filename,
      status,
      ${options.includeDuration ? "duration_ms" : "NULL AS duration_ms"},
      created_at,
      updated_at,
      article_title,
      substr(raw_text, 1, 120) AS raw_text_preview,
      ${options.includeProcessingStage ? "processing_stage" : "NULL AS processing_stage"},
      wechat_url,
      wechat_draft_id,
      ${options.includeCoverImage ? "cover_image_url" : "NULL AS cover_image_url"},
      ${options.includeSourceType ? "source_type" : "NULL AS source_type"},
      ${options.includeStyleProfile ? "style_profile_id" : "NULL AS style_profile_id"},
      ${options.includeStyleProfile ? "style_profile_version" : "NULL AS style_profile_version"},
      ${options.includeLayoutProfile ? "layout_profile_id" : "NULL AS layout_profile_id"},
      ${options.includeLayoutProfile ? "layout_profile_version" : "NULL AS layout_profile_version"},
      error_message
    FROM recordings
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT 100
    `,
  )
    .bind(...bindValues)
    .all();
  return results || [];
}

function relaxRecordingQueryOptions(options: RecordingQueryOptions, message: string): boolean {
  if (message.includes("duration_ms") && options.includeDuration) {
    options.includeDuration = false;
    return true;
  }
  if (message.includes("processing_stage") && options.includeProcessingStage) {
    options.includeProcessingStage = false;
    return true;
  }
  if (message.includes("cover_image_url") && options.includeCoverImage) {
    options.includeCoverImage = false;
    return true;
  }
  if (message.includes("source_type") && options.includeSourceType) {
    options.includeSourceType = false;
    return true;
  }
  if ((message.includes("style_profile_id") || message.includes("style_profile_version")) && options.includeStyleProfile) {
    options.includeStyleProfile = false;
    return true;
  }
  if ((message.includes("layout_profile_id") || message.includes("layout_profile_version")) && options.includeLayoutProfile) {
    options.includeLayoutProfile = false;
    return true;
  }
  if (message.includes("user_id") && options.includeUserIdFilter) {
    options.includeUserIdFilter = false;
    return true;
  }
  return false;
}

async function updateStatus(request: Request, env: Env): Promise<Response> {
  try {
    const body: any = await request.json();
    const {
      filename,
      status,
      rawText,
      articleTitle,
      articleContent,
      processingStage,
      processing_stage,
      wechatUrl,
      wechatDraftId,
      coverImageUrl,
      cover_image_url,
      errorMessage,
      error_message,
    } = body;
    const userId = normalizeOptionalString(body.user_id ?? body.userId) || bootstrapAdminUserId(env);
    if (!filename || !status) {
      return json({ error: "missing_fields" }, 400);
    }
    const stage = processingStage || processing_stage || null;
    const normalizedCoverImageUrl = normalizeRemoteReference(coverImageUrl ?? cover_image_url);
    const statusError = resolveStatusErrorUpdate({
      status,
      processingStage: stage,
      hasIncomingErrorMessage: hasOwn(body, "errorMessage") || hasOwn(body, "error_message"),
      incomingErrorMessage: errorMessage ?? error_message,
    });
    const values = [
      status,
      rawText || null,
      articleTitle || null,
      articleContent || null,
      stage,
      normalizeRemoteReference(wechatUrl),
      normalizeRemoteReference(wechatDraftId),
      normalizedCoverImageUrl,
      statusError.shouldSet ? 1 : 0,
      statusError.value,
      userId,
      filename,
    ];
    try {
      await env.DB.prepare(
        `
        UPDATE recordings
        SET
          status = ?,
          raw_text = COALESCE(?, raw_text),
          article_title = COALESCE(?, article_title),
          article_content = COALESCE(?, article_content),
          processing_stage = COALESCE(?, processing_stage),
          wechat_url = COALESCE(?, wechat_url),
          wechat_draft_id = COALESCE(?, wechat_draft_id),
          cover_image_url = COALESCE(?, cover_image_url),
          error_message = CASE WHEN ? = 1 THEN ? ELSE error_message END,
          updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND filename = ?
        `,
      )
        .bind(...values)
        .run();
    } catch (dbErr: any) {
      const message = String(dbErr?.message || "");
      if (!message.includes("cover_image_url")) throw dbErr;
      await env.DB.prepare(
        `
        UPDATE recordings
        SET
          status = ?,
          raw_text = COALESCE(?, raw_text),
          article_title = COALESCE(?, article_title),
          article_content = COALESCE(?, article_content),
          processing_stage = COALESCE(?, processing_stage),
          wechat_url = COALESCE(?, wechat_url),
          wechat_draft_id = COALESCE(?, wechat_draft_id),
          error_message = CASE WHEN ? = 1 THEN ? ELSE error_message END,
          updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND filename = ?
        `,
      )
        .bind(...values.filter((_, index) => index !== 7))
        .run();
    }
    return json({ ok: true });
  } catch (e: any) {
    console.error("Failed to update status:", e);
    return json({ error: "update_failed", details: e.message }, 500);
  }
}

async function handleMiningClaim(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const action = normalizeOptionalString(body?.action);
  const userId = normalizeOptionalString(body?.user_id ?? body?.userId);
  const targetKey = normalizeOptionalString(body?.target_key ?? body?.targetKey);
  const claimId = normalizeOptionalString(body?.claim_id ?? body?.claimId);

  if (!userId || !targetKey || !isMiningInputOwnedBy(userId, targetKey)) {
    return json({ error: "invalid_claim_target" }, 400);
  }
  if (!claimId || claimId.length > 200) {
    return json({ error: "invalid_claim_id" }, 400);
  }

  if (action === "claim") {
    const now = nowIso();
    const leaseExpiresAt = isoAfter(MINING_CLAIM_LEASE_MS);
    const result = await env.DB.prepare(
      `
      INSERT INTO mining_input_claims
        (user_id, target_key, state, claim_id, lease_expires_at, created_at, updated_at)
      VALUES (?, ?, 'processing', ?, ?, ?, ?)
      ON CONFLICT(user_id, target_key) DO UPDATE SET
        state = 'processing',
        claim_id = excluded.claim_id,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at,
        completed_at = NULL
      WHERE mining_input_claims.state = 'processing'
        AND mining_input_claims.lease_expires_at <= ?
      `,
    )
      .bind(userId, targetKey, claimId, leaseExpiresAt, now, now, now)
      .run();
    const claimed = (result.meta.changes ?? 0) > 0;
    return json({
      claimed,
      state: claimed ? "processing" : "already_claimed_or_completed",
    });
  }

  if (action === "complete") {
    const now = nowIso();
    const result = await env.DB.prepare(
      `
      UPDATE mining_input_claims
      SET state = 'completed', lease_expires_at = NULL, completed_at = ?, updated_at = ?
      WHERE user_id = ? AND target_key = ? AND claim_id = ? AND state = 'processing'
      `,
    )
      .bind(now, now, userId, targetKey, claimId)
      .run();
    return json({ completed: (result.meta.changes ?? 0) > 0 });
  }

  if (action === "release") {
    const result = await env.DB.prepare(
      `
      DELETE FROM mining_input_claims
      WHERE user_id = ? AND target_key = ? AND claim_id = ? AND state = 'processing'
      `,
    )
      .bind(userId, targetKey, claimId)
      .run();
    return json({ released: (result.meta.changes ?? 0) > 0 });
  }

  return json({ error: "invalid_claim_action" }, 400);
}

function isMiningInputOwnedBy(userId: string, targetKey: string): boolean {
  if (targetKey.includes("..")) return false;
  if (targetKey.startsWith(`users/${userId}/`)) return true;
  if (userId !== "default_user") return false;
  return targetKey.startsWith("inbox/") ||
    targetKey.startsWith("text-submissions/") ||
    targetKey.startsWith("revision-requests/");
}

function resolveStatusErrorUpdate(input: {
  status: string;
  processingStage?: string | null;
  hasIncomingErrorMessage: boolean;
  incomingErrorMessage?: unknown;
}): StatusErrorUpdate {
  if (input.hasIncomingErrorMessage) {
    return {
      shouldSet: true,
      value: normalizeOptionalString(input.incomingErrorMessage),
    };
  }

  if (keepsExistingErrorMessage(input.status, input.processingStage)) {
    return { shouldSet: false, value: null };
  }

  return { shouldSet: true, value: null };
}

function keepsExistingErrorMessage(status: string, processingStage?: string | null): boolean {
  const statusKey = statusKeyOf(status);
  const stageKey = statusKeyOf(processingStage || "");
  return statusKey === "FAILED" || isFailureStage(stageKey);
}

function isFailureStage(stageKey: string): boolean {
  return stageKey === "FAILED" ||
    stageKey === "ERROR" ||
    stageKey.endsWith("_FAILED");
}

function statusKeyOf(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[-\s]+/g, "_");
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeProfileSelectionFromBody(body: any): WritingProfileSelection {
  return {
    styleProfileId: normalizeOptionalString(body?.style_profile_id ?? body?.styleProfileId) || undefined,
    styleProfileVersion: normalizeOptionalString(body?.style_profile_version ?? body?.styleProfileVersion) || undefined,
    styleProfileName: normalizeOptionalString(body?.style_profile_name ?? body?.styleProfileName) || undefined,
    styleProfileDescription: normalizeOptionalString(body?.style_profile_description ?? body?.styleProfileDescription) || undefined,
    styleProfileBody: normalizeStyleProfileBody(body?.style_profile_body ?? body?.styleProfileBody) || undefined,
    layoutProfileId: normalizeOptionalString(body?.layout_profile_id ?? body?.layoutProfileId) || undefined,
    layoutProfileVersion: normalizeOptionalString(body?.layout_profile_version ?? body?.layoutProfileVersion) || undefined,
  };
}

function normalizeProfileSelectionFromHeaders(headers: Headers): WritingProfileSelection {
  return {
    styleProfileId: normalizeOptionalString(headers.get("x-style-profile-id")) || undefined,
    styleProfileVersion: normalizeOptionalString(headers.get("x-style-profile-version")) || undefined,
    styleProfileName: normalizeOptionalString(decodeBase64Header(headers.get("x-style-profile-name-b64"))) || undefined,
    styleProfileDescription: normalizeOptionalString(decodeBase64Header(headers.get("x-style-profile-description-b64"))) || undefined,
    styleProfileBody: normalizeStyleProfileBody(decodeBase64Header(headers.get("x-style-profile-body-b64"))) || undefined,
    layoutProfileId: normalizeOptionalString(headers.get("x-layout-profile-id")) || undefined,
    layoutProfileVersion: normalizeOptionalString(headers.get("x-layout-profile-version")) || undefined,
  };
}

function profileSelectionMetadata(selection: WritingProfileSelection): Record<string, string> {
  const metadata: Record<string, string> = {};
  if (selection.styleProfileId) metadata.styleProfileId = selection.styleProfileId;
  if (selection.styleProfileVersion) metadata.styleProfileVersion = selection.styleProfileVersion;
  if (selection.layoutProfileId) metadata.layoutProfileId = selection.layoutProfileId;
  if (selection.layoutProfileVersion) metadata.layoutProfileVersion = selection.layoutProfileVersion;
  return metadata;
}

function profileSelectionPayload(selection: WritingProfileSelection): Record<string, string> {
  const payload: Record<string, string> = {};
  if (selection.styleProfileId) payload.styleProfileId = selection.styleProfileId;
  if (selection.styleProfileVersion) payload.styleProfileVersion = selection.styleProfileVersion;
  if (selection.styleProfileName) payload.styleProfileName = selection.styleProfileName;
  if (selection.styleProfileDescription) payload.styleProfileDescription = selection.styleProfileDescription;
  if (selection.styleProfileBody) payload.styleProfileBody = selection.styleProfileBody;
  if (selection.layoutProfileId) payload.layoutProfileId = selection.layoutProfileId;
  if (selection.layoutProfileVersion) payload.layoutProfileVersion = selection.layoutProfileVersion;
  return payload;
}

function hasInlineProfileSelection(selection: WritingProfileSelection): boolean {
  return Boolean(selection.styleProfileBody || selection.styleProfileName || selection.styleProfileDescription);
}

function normalizeStyleProfileBody(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.slice(0, MAX_INLINE_STYLE_PROFILE_BODY_CHARS) : null;
}

function decodeBase64Header(value: string | null): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  try {
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function profileSelectionSidecarKey(userId: string, filename: string): string {
  return userScopedKey(userId, "profile-selections", `${filename.replace(/[^\w.\-]/g, "_")}.json`);
}

function normalizeRemoteReference(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;

  const lowered = normalized.toLowerCase();
  return lowered === "null" || lowered === "undefined" ? null : normalized;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

async function getFile(env: Env, auth: AuthContext, encodedKey: string): Promise<Response> {
  const key = safeDecodeURIComponent(encodedKey);

  if (!key || key.includes("..")) {
    return json({ error: "invalid_key" }, 400);
  }
  if (!canAccessR2Key(auth, key)) {
    return json({ error: "forbidden" }, 403);
  }

  const object = await env.FILES_BUCKET.get(key);
  if (!object) {
    return json({ error: "not_found" }, 404);
  }

  const headers = new Headers(corsHeaders);
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=60");

  return new Response(object.body, { headers });
}

type TranscriptRecordingProjection = {
  id: number;
  status: string;
  raw_text: string | null;
  article_title: string | null;
  article_content: string | null;
  processing_stage: string | null;
  wechat_url: string | null;
  wechat_draft_id: string | null;
  cover_image_url: string | null;
  error_message: string | null;
};

async function loadTranscriptRecordingProjection(
  env: Env,
  auth: AuthContext,
  filename: string,
): Promise<TranscriptRecordingProjection | null> {
  const columns = `r.id, r.status, r.raw_text, r.article_title, r.article_content,
    r.processing_stage, r.wechat_url, r.wechat_draft_id, r.cover_image_url, r.error_message`;
  try {
    return await env.DB.prepare(`SELECT ${columns}
      FROM recordings r
      JOIN editorial_recording_scopes s ON s.recording_id = r.id AND s.user_id = r.user_id
      WHERE r.user_id = ? AND s.workspace_id = ? AND r.filename = ? LIMIT 1`)
      .bind(auth.userId, auth.workspaceId, filename)
      .first<TranscriptRecordingProjection>();
  } catch (error) {
    const message = String((error as { message?: unknown })?.message || error);
    if (!message.includes("no such table: editorial_recording_scopes")) throw error;
    return env.DB.prepare(`SELECT id, status, raw_text, article_title, article_content,
        processing_stage, wechat_url, wechat_draft_id, cover_image_url, error_message
      FROM recordings WHERE user_id = ? AND filename = ? LIMIT 1`)
      .bind(auth.userId, filename)
      .first<TranscriptRecordingProjection>();
  }
}

async function getTranscript(env: Env, auth: AuthContext, filename: string): Promise<Response> {
  const safeName = sanitizeFileName(filename).replace(/\.[^/.]+$/, ".json");
  const key = userScopedKey(auth.userId, "transcripts", safeName);
  if (!canAccessR2Key(auth, key)) return json({ error: "forbidden" }, 403);

  const object = await env.FILES_BUCKET.get(key);
  let original: Record<string, unknown> = {};
  if (object) {
    try {
      const parsed = JSON.parse(await object.text()) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return json({ error: "transcript_payload_invalid" }, 503, { "cache-control": "private, max-age=0" });
      }
      original = parsed as Record<string, unknown>;
    } catch {
      return json({ error: "transcript_payload_invalid" }, 503, { "cache-control": "private, max-age=0" });
    }
  }

  let recording: TranscriptRecordingProjection | null = null;
  try {
    recording = await loadTranscriptRecordingProjection(env, auth, filename);
  } catch (error) {
    console.error("Failed to load transcript compatibility projection:", error);
    return json({ error: "transcript_projection_unavailable" }, 503, { "cache-control": "private, max-age=0" });
  }
  if (!recording) {
    return object
      ? json(original, 200, { "cache-control": "private, max-age=0" })
      : json({ error: "not_found" }, 404, { "cache-control": "private, max-age=0" });
  }

  let articleTitle = normalizeOptionalString(recording.article_title);
  let articleContent = normalizeOptionalString(recording.article_content);
  let processingStage = normalizeOptionalString(recording.processing_stage);
  let articleVersionId: string | null = null;
  let articleVersionNo: number | null = null;
  if (publicationTenantFeatureEnabled(env, auth.userId, auth.workspaceId)) {
    try {
      const frozen = await reconcileFrozenArticleRecordingProjection(
        env as unknown as EditorialRuntimeEnv,
        { recordingId: recording.id, userId: auth.userId, workspaceId: auth.workspaceId },
      );
      if (frozen) {
        articleTitle = frozen.title;
        articleContent = frozen.body;
        processingStage = frozen.processingStage;
        articleVersionId = frozen.versionId || null;
        articleVersionNo = frozen.versionNo || null;
      }
    } catch (error) {
      console.error("Failed to reconcile frozen article transcript projection:", error);
      return json({ error: "transcript_projection_unavailable" }, 503, { "cache-control": "private, max-age=0" });
    }
  }
  if (!object && !articleContent) {
    return json({ error: "not_found" }, 404, { "cache-control": "private, max-age=0" });
  }

  const merged: Record<string, unknown> = { ...original };
  const putBoth = (camel: string, snake: string, value: string | null): void => {
    if (!value) return;
    merged[camel] = value;
    merged[snake] = value;
  };
  putBoth("rawText", "raw_text", normalizeOptionalString(recording.raw_text));
  putBoth("articleTitle", "article_title", articleTitle);
  putBoth("articleContent", "article_content", articleContent);
  if (articleVersionId && articleVersionNo) {
    merged.articleVersion = articleVersionNo;
    merged.article_version = articleVersionNo;
    merged.articleVersionId = articleVersionId;
    merged.article_version_id = articleVersionId;
  }
  putBoth("processingStage", "processing_stage", articleContent ? (processingStage || "ARTICLE_READY") : processingStage);
  putBoth("wechatUrl", "wechat_url", normalizeRemoteReference(recording.wechat_url));
  putBoth("wechatDraftId", "wechat_draft_id", normalizeRemoteReference(recording.wechat_draft_id));
  putBoth("coverImageUrl", "cover_image_url", normalizeRemoteReference(recording.cover_image_url));
  putBoth("errorMessage", "error_message", normalizeOptionalString(recording.error_message));
  merged.status = recording.status;
  return json(merged, 200, { "cache-control": "private, max-age=0" });
}

function canAccessR2Key(auth: AuthContext, key: string): boolean {
  if (key.startsWith(`users/${auth.userId}/`)) return true;
  if (auth.legacy) {
    return key.startsWith("inbox/") ||
      key.startsWith("text-submissions/") ||
      key.startsWith("transcripts/") ||
      key.startsWith("covers/") ||
      key.startsWith("article-images/") ||
      key.startsWith("revision-requests/") ||
      key.startsWith("profile-selections/");
  }
  return false;
}

function userScopedPrefix(userId: string, kind: string): string {
  return `users/${userId}/${kind.replace(/^\/+|\/+$/g, "")}/`;
}

function userScopedKey(userId: string, kind: string, name: string): string {
  return `${userScopedPrefix(userId, kind)}${name.replace(/^\/+/, "")}`;
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseDurationMsFromRecordingFilename(filename: unknown): number | null {
  if (typeof filename !== "string") return null;
  const match = filename.match(/-(\d+)m(\d+)s(?:-|\.|$)/);
  if (!match) return null;

  const minutes = Number.parseInt(match[1], 10);
  const seconds = Number.parseInt(match[2], 10);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  return ((minutes * 60) + seconds) * 1_000;
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
}

function validatePassword(password: string): Response | null {
  if (password.length < 8) {
    return json({ error: "weak_password", message: "密码至少需要 8 个字符" }, 400);
  }
  return null;
}

async function hashPassword(password: string): Promise<{ hash: string; salt: string; iterations: number }> {
  const saltBytes = randomBytes(16);
  const bits = await derivePasswordBits(password, saltBytes, PASSWORD_ITERATIONS);
  return {
    hash: base64UrlEncode(new Uint8Array(bits)),
    salt: base64UrlEncode(saltBytes),
    iterations: PASSWORD_ITERATIONS,
  };
}

async function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string,
  iterations: number,
): Promise<boolean> {
  const saltBytes = base64UrlDecode(salt);
  const bits = await derivePasswordBits(password, saltBytes, iterations || PASSWORD_ITERATIONS);
  return secureTokenEquals(expectedHash, base64UrlEncode(new Uint8Array(bits)));
}

async function derivePasswordBits(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
}

async function encryptSecret(env: Env, plaintext: string): Promise<string> {
  const key = await credentialKey(env);
  const iv = randomBytes(12);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `v1:${base64UrlEncode(iv)}:${base64UrlEncode(new Uint8Array(cipher))}`;
}

async function decryptSecret(env: Env, ciphertext: string): Promise<string> {
  if (ciphertext.startsWith("plain:")) {
    return ciphertext.slice("plain:".length);
  }
  const [, ivEncoded, cipherEncoded] = ciphertext.split(":");
  if (!ivEncoded || !cipherEncoded) throw new Error("Invalid encrypted credential");
  const key = await credentialKey(env);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(ivEncoded) },
    key,
    base64UrlDecode(cipherEncoded),
  );
  return new TextDecoder().decode(plain);
}

async function credentialKey(env: Env): Promise<CryptoKey> {
  const secret = env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!secret) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY is required for publishing credentials");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function sendTransactionalEmail(
  env: Env,
  input: { to: string; subject: string; text: string; html: string },
): Promise<void> {
  if (!env.EMAIL?.send) {
    console.warn(`EMAIL binding is not configured. Email not sent: ${input.subject} -> ${input.to}`);
    return;
  }
  await env.EMAIL.send({
    to: input.to,
    from: emailFrom(env),
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
}

function emailFrom(env: Env): string | { email: string; name?: string } {
  const value = env.EMAIL_FROM?.trim() || "no-reply@vibepub.litianc.cn";
  const match = value.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim() || "VibePub", email: match[2].trim() };
  }
  return { name: "VibePub", email: value };
}

function authLink(env: Env, path: "accept-invite" | "reset-password" | "verify-email", token: string): string {
  const base = env.INVITE_BASE_URL?.trim() || `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/auth`;
  const separator = base.includes("?") ? "&" : "?";
  return `${base.replace(/\/+$/, "")}/${path}${separator}token=${encodeURIComponent(token)}`;
}

async function parseJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function queryAll<T = unknown>(env: Env, sql: string, values: unknown[] = []): Promise<T[]> {
  const { results } = await env.DB.prepare(sql).bind(...values).all<T>();
  return results || [];
}

async function queryOne<T = unknown>(env: Env, sql: string, values: unknown[] = []): Promise<T | null> {
  const rows = await queryAll<T>(env, sql, values);
  return rows[0] || null;
}

async function sha256Hex(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function secureTokenEquals(expected: string, candidate: string): Promise<boolean> {
  if (!candidate) return false;
  const encoder = new TextEncoder();
  const [expectedDigest, candidateDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
  ]);
  const expectedBytes = new Uint8Array(expectedDigest);
  const candidateBytes = new Uint8Array(candidateDigest);
  let diff = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    diff |= expectedBytes[index] ^ candidateBytes[index];
  }
  return diff === 0;
}

function randomToken(): string {
  return base64UrlEncode(randomBytes(32));
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoAfter(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function isPast(value: unknown): boolean {
  if (typeof value !== "string" || !value) return true;
  return Date.parse(value) <= Date.now();
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 120) || "recording.m4a";
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function deploymentVersion(env: Env): Record<string, string | null> {
  return {
    commit: metadataValue(env.DEPLOY_COMMIT),
    ref: metadataValue(env.DEPLOY_REF),
    deployed_at: metadataValue(env.DEPLOYED_AT),
  };
}

const ADAPTER_HEALTH_SERVICES = {
  writing: { binding: "WRITING_AGENT", service: "writing-agent" },
  review: { binding: "REVIEW_AGENT", service: "editorial-review-agent" },
  image: { binding: "IMAGE_GENERATION_ADAPTER", service: "image-generation-adapter" },
  wechat: { binding: "WECHAT_PUBLISHING_ADAPTER", service: "wechat-publishing-adapter" },
} as const;

type AdapterHealth = {
  service: string;
  version: Record<string, string | null>;
};

async function collectAdapterHealth(env: Env): Promise<Record<keyof typeof ADAPTER_HEALTH_SERVICES, AdapterHealth>> {
  const entries = await Promise.all(Object.entries(ADAPTER_HEALTH_SERVICES).map(async ([role, expected]) => {
    const binding = env[expected.binding];
    if (!binding) throw new Error("adapter health binding missing");
    const response = await binding.fetch(new Request("https://vibepub.internal/health"));
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !payload || payload.ok !== true || payload.service !== expected.service ||
        !payload.version || typeof payload.version !== "object" || Array.isArray(payload.version)) {
      throw new Error("adapter health response invalid");
    }
    const version = payload.version as Record<string, unknown>;
    const normalized = {
      commit: typeof version.commit === "string" ? version.commit : null,
      ref: typeof version.ref === "string" ? version.ref : null,
      deployed_at: typeof version.deployed_at === "string" ? version.deployed_at : null,
    };
    return [role, { service: expected.service, version: normalized }] as const;
  }));
  return Object.fromEntries(entries) as unknown as Record<keyof typeof ADAPTER_HEALTH_SERVICES, AdapterHealth>;
}

function metadataValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
