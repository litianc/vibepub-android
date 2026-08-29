import { describe, expect, it } from 'vitest';
import { verifyRevisionReadbackEvidence } from '../src/verifyRevisionReadback.js';

const hash = `sha256:${'a'.repeat(64)}`;

describe('revision WeChat readback evidence', () => {
  const request = {
    revisionId: 'revision_1',
    transcriptKey: 'users/user_1/transcripts/recording.json',
  };
  const transcript = {
    articleVersionId: 'version_2',
    articleVersionNo: 2,
    revisionHistory: [{
      revisionId: 'revision_1',
      articleVersionId: 'version_2',
      articleVersionNo: 2,
      wechatDraftReadback: {
        verified: true,
        mediaIdHash: hash,
        expectedTitleHash: hash,
        titleHash: hash,
        expectedContentHash: hash,
        contentHash: hash,
        verifiedAt: '2026-08-29T13:00:00.000Z',
      },
    }],
  };

  it('accepts only an exact v2 readback bound to the revision and child version', () => {
    expect(verifyRevisionReadbackEvidence(request, transcript, {
      revisionId: 'revision_1', childVersionId: 'version_2', minimumVerifiedAt: '2026-08-29T12:59:00.000Z',
    })).toEqual({
      verified: true,
      revision_id_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      child_version_id_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      media_id_hash: hash,
      title_hash: hash,
      content_hash: hash,
      verified_at: '2026-08-29T13:00:00.000Z',
    });
  });

  it('rejects stale, mismatched, or unverified evidence', () => {
    expect(() => verifyRevisionReadbackEvidence(request, transcript, {
      revisionId: 'revision_other', childVersionId: 'version_2', minimumVerifiedAt: '2026-08-29T12:59:00.000Z',
    })).toThrow('revision_readback_identity_invalid');
    expect(() => verifyRevisionReadbackEvidence(request, transcript, {
      revisionId: 'revision_1', childVersionId: 'version_2', minimumVerifiedAt: '2026-08-29T13:01:00.000Z',
    })).toThrow('revision_readback_stale');
    expect(() => verifyRevisionReadbackEvidence(request, {
      ...transcript,
      revisionHistory: [{ ...transcript.revisionHistory[0], wechatDraftReadback: { ...transcript.revisionHistory[0].wechatDraftReadback, verified: false } }],
    }, {
      revisionId: 'revision_1', childVersionId: 'version_2', minimumVerifiedAt: '2026-08-29T12:59:00.000Z',
    })).toThrow('revision_readback_unverified');
    expect(() => verifyRevisionReadbackEvidence(request, {
      ...transcript,
      revisionHistory: [{ ...transcript.revisionHistory[0], wechatDraftReadback: { ...transcript.revisionHistory[0].wechatDraftReadback, contentHash: `sha256:${'b'.repeat(64)}` } }],
    }, {
      revisionId: 'revision_1', childVersionId: 'version_2', minimumVerifiedAt: '2026-08-29T12:59:00.000Z',
    })).toThrow('revision_readback_mismatch');
  });
});
