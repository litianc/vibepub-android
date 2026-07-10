import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { processAudioText, reviseArticleWithInstruction } from '../src/llm.js';
import { generateWechatCoverBuffer } from '../src/coverRenderer.js';
import { prepareArticleImages } from '../src/articleImages.js';
import { getAccessToken, publishDraft, updateDraft, uploadWechatArticleImage } from '../src/wechat.js';
import { createPresignedDownloadUrl, deleteFile, downloadFile, getFileMetadata, listUnprocessedFiles, uploadCoverImage, uploadTranscript } from '../src/r2.js';
import { transcribeAudioUrl } from '../src/asr.js';
import { buildArticleTranscriptPayload, filterTargetFiles, main } from '../src/index.js';

// Mock dependencies
vi.mock('../src/llm.js', () => ({
  processAudioText: vi.fn(),
  reviseArticleWithInstruction: vi.fn(),
}));

vi.mock('../src/coverRenderer.js', () => ({
  generateWechatCoverBuffer: vi.fn()
}));

vi.mock('../src/articleImages.js', () => ({
  prepareArticleImages: vi.fn()
}));

vi.mock('../src/wechat.js', () => ({
  publishDraft: vi.fn(),
  updateDraft: vi.fn(),
  getAccessToken: vi.fn(),
  uploadWechatArticleImage: vi.fn()
}));

vi.mock('../src/r2.js', () => ({
  listUnprocessedFiles: vi.fn(),
  createPresignedDownloadUrl: vi.fn(),
  downloadFile: vi.fn(),
  getFileMetadata: vi.fn(),
  deleteFile: vi.fn(),
  uploadCoverImage: vi.fn(),
  uploadTranscript: vi.fn(),
  isSupportedTextSubmissionKey: (key: string) =>
    key.startsWith('text-submissions/') && (key.endsWith('.txt') || key.endsWith('.json')),
  userIdFromPipelineKey: (key: string) => key.match(/^users\/([^/]+)\//)?.[1],
}));

vi.mock('../src/asr.js', () => ({
  transcribeAudioUrl: vi.fn()
}));

describe('VibePub Cloud Pipeline', () => {
  const originalEnv = { ...process.env };
  const testWechatConfig = {
    appId: 'wx-test-app',
    appSecret: 'wx-test-secret',
    proxyUrl: 'https://wechat-proxy.example.test',
  };

  function mockFetchWithPublishingAccount(account = testWechatConfig) {
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input).includes('/api/internal/mining-claims')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ claimed: true, completed: true, released: true }),
          text: async () => '',
        } as any;
      }
      if (String(input).includes('/api/internal/publishing-account')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            publishing_account: {
              app_id: account.appId,
              app_secret: account.appSecret,
              proxy_url: account.proxyUrl,
            },
          }),
          text: async () => '',
        } as any;
      }

      return {
        ok: true,
        status: 200,
        text: async () => '',
      } as any;
    }));
  }

  function statusUpdateBodies() {
    return vi.mocked(fetch).mock.calls
      .filter(([input]) => String(input).includes('/api/internal/status'))
      .map(([, init]) => JSON.parse(String(init?.body)));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      PUBLIC_BASE_URL: 'https://vibepub.example.test',
      FILES_TOKEN: 'test-files-token',
      MINING_SERVICE_TOKEN: 'test-mining-service-token',
      TARGET_FILENAME: '',
      REVISION_REQUEST_KEY: '',
      WECHAT_APP_ID: '',
      WECHAT_APP_SECRET: '',
      WECHAT_PROXY: '',
    };
    mockFetchWithPublishingAccount();
    vi.mocked(getFileMetadata).mockResolvedValue({});
    vi.mocked(prepareArticleImages).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it('should process audio text and return title, content, and cover fields', async () => {
    const mockRawText = "Hello this is a test recording.";
    const mockProcessedResult = {
      title: "Test Title",
      content: "<p>Test Content</p>",
      imagePrompt: "A futuristic testing landscape",
      coverTitle: ["Test", "Title"],
      coverSubtitle: "Test subtitle",
    };

    vi.mocked(processAudioText).mockResolvedValue(mockProcessedResult);

    const result = await processAudioText(mockRawText);
    expect(result.title).toBe("Test Title");
    expect(result.imagePrompt).toBe("A futuristic testing landscape");
    expect(result.coverTitle).toEqual(["Test", "Title"]);
  });

  it('should generate a deterministic WeChat cover from title fields', async () => {
    const mockBuffer = Buffer.from("fake-image-data");

    vi.mocked(generateWechatCoverBuffer).mockResolvedValue(mockBuffer);

    const buffer = await generateWechatCoverBuffer({
      title: "为什么我不建议用 Vibe Coding 搭建数据仪表盘",
      titleLines: ["不建议", "Vibe Coding", "搭数据仪表盘"],
      subtitle: "原型速度 ≠ 数据可信度",
    });
    expect(buffer).toBeDefined();
    expect(buffer.toString()).toBe("fake-image-data");
  });

  it('should upload draft to WeChat successfully', async () => {
    const mockToken = "fake-wechat-token";
    const mockTitle = "Test Title";
    const mockContent = "<p>Test Content</p>";
    const mockBuffer = Buffer.from("fake-image-data");

    vi.mocked(publishDraft).mockResolvedValue("draft-media-id-123");

    const mediaId = await publishDraft(mockToken, mockTitle, mockContent, mockBuffer);
    expect(mediaId).toBe("draft-media-id-123");
  });

  it('should filter mining files by exact target filename', () => {
    const files = [
      'inbox/VibePub-2026-06-29-100000-0m30s-Debug-Audio-Import.mp3',
      'inbox/stale-silence.mp3',
      'inbox/other.mp3',
    ];

    expect(filterTargetFiles(files, 'VibePub-2026-06-29-100000-0m30s-Debug-Audio-Import.mp3')).toEqual([
      'inbox/VibePub-2026-06-29-100000-0m30s-Debug-Audio-Import.mp3',
    ]);
    expect(filterTargetFiles(files, undefined)).toEqual(files);
    expect(filterTargetFiles(files, 'missing.mp3')).toEqual([]);
  });

  it('should skip an input already claimed by an active or completed mining run', async () => {
    const fileKey = 'inbox/VibePub-2026-07-10-140000-0m30s-Already-Claimed.mp3';
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input).includes('/api/internal/mining-claims')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ claimed: false }),
          text: async () => '',
        } as any;
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }));
    vi.mocked(listUnprocessedFiles).mockResolvedValue([fileKey]);

    await expect(main()).resolves.toBeUndefined();

    expect(transcribeAudioUrl).not.toHaveBeenCalled();
    expect(processAudioText).not.toHaveBeenCalled();
    expect(publishDraft).not.toHaveBeenCalled();
    expect(statusUpdateBodies()).toEqual([]);
  });

  it('should build transcript payload with article and draft metadata', () => {
    const payload = buildArticleTranscriptPayload(
      'raw transcript',
      {
        title: 'Article title',
        content: '<p>Article body</p>',
        imagePrompt: 'cover prompt',
      },
      {
        processingStage: 'DRAFT_FAILED',
        coverImageUrl: 'https://vibepub.example.test/api/files/covers%2FArticle.png',
        errorMessage: '公众号草稿创建失败：502',
      },
    );

    expect(payload).toMatchObject({
      rawText: 'raw transcript',
      articleTitle: 'Article title',
      articleContent: '<p>Article body</p>',
      coverImageUrl: 'https://vibepub.example.test/api/files/covers%2FArticle.png',
      processingStage: 'DRAFT_FAILED',
      errorMessage: '公众号草稿创建失败：502',
    });
  });

  it('should publish article-ready progress before starting WeChat draft work', async () => {
    const fileKey = 'inbox/VibePub-2026-06-30-044540-0m30s-Debug-Audio-Import.mp3';
    const filename = 'VibePub-2026-06-30-044540-0m30s-Debug-Audio-Import.mp3';
    const article = {
      title: '把口述想法变成文章',
      content: '<p>这是一篇已经生成完成、可以先阅读和复制的文章正文。</p>',
      imagePrompt: 'A clean editorial cover',
      coverTitle: ['口述想法', '变成文章'],
      coverSubtitle: '写作成本更低',
    };

    vi.mocked(listUnprocessedFiles).mockResolvedValue([fileKey]);
    vi.mocked(createPresignedDownloadUrl).mockResolvedValue('https://r2.example.test/audio.mp3');
    vi.mocked(transcribeAudioUrl).mockResolvedValue('今天我想记录一下怎么减少写作成本。');
    vi.mocked(processAudioText).mockResolvedValue(article);
    vi.mocked(generateWechatCoverBuffer).mockResolvedValue(Buffer.from('fake-cover'));
    vi.mocked(getAccessToken).mockResolvedValue('wechat-token');
    vi.mocked(publishDraft).mockResolvedValue('MEDIA_ID_123');
    vi.mocked(uploadCoverImage).mockResolvedValue();
    vi.mocked(uploadTranscript).mockResolvedValue();
    vi.mocked(deleteFile).mockResolvedValue();

    await expect(main()).resolves.toBeUndefined();

    const fetchCalls = statusUpdateBodies();
    expect(fetchCalls.map(call => call.processingStage)).toEqual([
      'QUEUED',
      'ASR',
      'REWRITING',
      'ARTICLE_READY',
      'DRAFTING',
      'COMPLETED',
    ]);
    expect(fetchCalls).toContainEqual(expect.objectContaining({
      filename,
      status: 'PROCESSING',
      articleTitle: article.title,
      articleContent: article.content,
      processingStage: 'ARTICLE_READY',
    }));
    expect(generateWechatCoverBuffer).toHaveBeenCalledWith({
      title: article.title,
      titleLines: article.coverTitle,
      subtitle: article.coverSubtitle,
      imagePrompt: article.imagePrompt,
    });
    expect(uploadCoverImage).toHaveBeenCalledWith(
      'covers/VibePub-2026-06-30-044540-0m30s-Debug-Audio-Import.png',
      Buffer.from('fake-cover'),
    );
    expect(fetchCalls).toContainEqual(expect.objectContaining({
      filename,
      status: 'COMPLETED',
      articleTitle: article.title,
      articleContent: article.content,
      coverImageUrl: 'https://vibepub.example.test/api/files/covers%2FVibePub-2026-06-30-044540-0m30s-Debug-Audio-Import.png',
      processingStage: 'COMPLETED',
      wechatDraftId: 'MEDIA_ID_123',
    }));
  });

  it('should process text submissions without ASR', async () => {
    const fileKey = 'text-submissions/VibePub-2026-07-04-112233-Text-abcd1234.txt';
    const filename = 'VibePub-2026-07-04-112233-Text-abcd1234.txt';
    const article = {
      title: '把手动输入也纳入成文流程',
      content: '<p>这是一篇由手动文字生成的公众号文章。</p>'.repeat(4),
      imagePrompt: 'A clean editorial cover',
      coverTitle: ['手动输入', '也能成文'],
      coverSubtitle: '不方便录音时的入口',
    };

    vi.mocked(listUnprocessedFiles).mockResolvedValue([fileKey]);
    vi.mocked(downloadFile).mockResolvedValue(Buffer.from(JSON.stringify({
      text: '这是一段用户在手机上手动输入的原始想法。',
      titleHint: '手动输入也要能发布',
    })));
    vi.mocked(processAudioText).mockResolvedValue(article);
    vi.mocked(generateWechatCoverBuffer).mockResolvedValue(Buffer.from('fake-cover'));
    vi.mocked(getAccessToken).mockResolvedValue('wechat-token');
    vi.mocked(publishDraft).mockResolvedValue('MEDIA_ID_TEXT');
    vi.mocked(uploadCoverImage).mockResolvedValue();
    vi.mocked(uploadTranscript).mockResolvedValue();
    vi.mocked(deleteFile).mockResolvedValue();

    await expect(main()).resolves.toBeUndefined();

    expect(createPresignedDownloadUrl).not.toHaveBeenCalled();
    expect(transcribeAudioUrl).not.toHaveBeenCalled();
    expect(processAudioText).toHaveBeenCalledWith(
      '标题提示：手动输入也要能发布\n\n这是一段用户在手机上手动输入的原始想法。',
    );

    const fetchCalls = statusUpdateBodies();
    expect(fetchCalls.map(call => call.processingStage)).toEqual([
      'QUEUED',
      'REWRITING',
      'REWRITING',
      'ARTICLE_READY',
      'DRAFTING',
      'COMPLETED',
    ]);
    expect(uploadTranscript).toHaveBeenCalledWith(
      'transcripts/VibePub-2026-07-04-112233-Text-abcd1234.json',
      expect.any(String),
    );
    expect(uploadCoverImage).toHaveBeenCalledWith(
      'covers/VibePub-2026-07-04-112233-Text-abcd1234.png',
      Buffer.from('fake-cover'),
    );
    expect(fetchCalls).toContainEqual(expect.objectContaining({
      filename,
      status: 'COMPLETED',
      articleTitle: article.title,
      articleContent: article.content,
      coverImageUrl: 'https://vibepub.example.test/api/files/covers%2FVibePub-2026-07-04-112233-Text-abcd1234.png',
      processingStage: 'COMPLETED',
      wechatDraftId: 'MEDIA_ID_TEXT',
    }));
  });

  it('should keep generated article visible when WeChat draft publishing fails', async () => {
    const fileKey = 'inbox/VibePub-2026-06-30-044540-0m30s-Debug-Audio-Import.mp3';
    const filename = 'VibePub-2026-06-30-044540-0m30s-Debug-Audio-Import.mp3';
    const article = {
      title: '别让 AI 仪表盘变成业务幻觉',
      content: '<p>这是一篇已经生成完成、可以在 App 里阅读和复制的文章正文。</p>'.repeat(4),
      imagePrompt: 'A clean editorial cover',
      coverTitle: ['别让 AI', '仪表盘', '变成幻觉'],
      coverSubtitle: '可信度优先',
    };

    vi.mocked(listUnprocessedFiles).mockResolvedValue([fileKey]);
    vi.mocked(createPresignedDownloadUrl).mockResolvedValue('https://r2.example.test/audio.mp3');
    vi.mocked(transcribeAudioUrl).mockResolvedValue('Some entrepreneurs ask their employees to build dashboards.');
    vi.mocked(processAudioText).mockResolvedValue(article);
    vi.mocked(generateWechatCoverBuffer).mockResolvedValue(Buffer.from('fake-cover'));
    vi.mocked(getAccessToken).mockResolvedValue('wechat-token');
    vi.mocked(publishDraft).mockRejectedValue(new Error('Request failed with status code 502'));
    vi.mocked(uploadCoverImage).mockResolvedValue();
    vi.mocked(uploadTranscript).mockResolvedValue();
    vi.mocked(deleteFile).mockResolvedValue();

    await expect(main()).resolves.toBeUndefined();

    expect(uploadTranscript).toHaveBeenCalledWith(
      'transcripts/VibePub-2026-06-30-044540-0m30s-Debug-Audio-Import.json',
      expect.stringContaining('"processingStage":"DRAFT_FAILED"'),
    );
    expect(deleteFile).toHaveBeenCalledWith(fileKey);

    const fetchCalls = statusUpdateBodies();
    expect(fetchCalls).toContainEqual(expect.objectContaining({
      filename,
      status: 'COMPLETED',
      articleTitle: article.title,
      articleContent: article.content,
      coverImageUrl: 'https://vibepub.example.test/api/files/covers%2FVibePub-2026-06-30-044540-0m30s-Debug-Audio-Import.png',
      processingStage: 'DRAFT_FAILED',
    }));
    expect(fetchCalls.some(call =>
      call.status === 'FAILED' &&
        call.filename === filename
    )).toBe(false);
  });

  it('should keep article visible without falling back to legacy WeChat credentials for unbound authenticated users', async () => {
    const fileKey = 'users/usr_unbound/inbox/VibePub-2026-07-07-230000-0m30s-Unbound-WeChat.mp3';
    const filename = 'VibePub-2026-07-07-230000-0m30s-Unbound-WeChat.mp3';
    const article = {
      title: '未绑定公众号也要能读文章',
      content: '<p>这篇文章已经生成，但当前用户还没有绑定公众号。</p>'.repeat(4),
      imagePrompt: 'A clean editorial cover',
      coverTitle: ['未绑定', '公众号', '也能读'],
      coverSubtitle: '账号隔离优先',
    };

    process.env.WECHAT_APP_ID = 'legacy-app-id';
    process.env.WECHAT_APP_SECRET = 'legacy-secret';
    process.env.WECHAT_PROXY = 'https://legacy-wechat-proxy.example.test';
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input).includes('/api/internal/mining-claims')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ claimed: true, completed: true, released: true }),
          text: async () => '',
        } as any;
      }
      if (String(input).includes('/api/internal/publishing-account')) {
        return {
          ok: false,
          status: 404,
          text: async () => '{"error":"publishing_account_not_configured"}',
        } as any;
      }

      return {
        ok: true,
        status: 200,
        text: async () => '',
      } as any;
    }));

    vi.mocked(listUnprocessedFiles).mockResolvedValue([fileKey]);
    vi.mocked(createPresignedDownloadUrl).mockResolvedValue('https://r2.example.test/audio.mp3');
    vi.mocked(transcribeAudioUrl).mockResolvedValue('今天我想测试用户没有绑定公众号时的成文结果。');
    vi.mocked(processAudioText).mockResolvedValue(article);
    vi.mocked(generateWechatCoverBuffer).mockResolvedValue(Buffer.from('fake-cover'));
    vi.mocked(uploadCoverImage).mockResolvedValue();
    vi.mocked(uploadTranscript).mockResolvedValue();
    vi.mocked(deleteFile).mockResolvedValue();

    await expect(main()).resolves.toBeUndefined();

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(publishDraft).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledWith(fileKey);
    expect(uploadTranscript).toHaveBeenCalledWith(
      'users/usr_unbound/transcripts/VibePub-2026-07-07-230000-0m30s-Unbound-WeChat.json',
      expect.stringContaining('"processingStage":"DRAFT_FAILED"'),
    );

    const fetchCalls = statusUpdateBodies();
    expect(fetchCalls).toContainEqual(expect.objectContaining({
      filename,
      userId: 'usr_unbound',
      status: 'COMPLETED',
      articleTitle: article.title,
      articleContent: article.content,
      processingStage: 'DRAFT_FAILED',
      errorMessage: expect.stringContaining('公众号未绑定'),
    }));
    expect(fetchCalls.some(call => call.wechatDraftId)).toBe(false);
  });

  it('should keep generated article visible when cover generation fails after article-ready progress', async () => {
    const fileKey = 'inbox/VibePub-2026-06-30-055501-0m30s-Cover-Failure.mp3';
    const filename = 'VibePub-2026-06-30-055501-0m30s-Cover-Failure.mp3';
    const article = {
      title: '先保住已经写好的文章',
      content: '<p>文章已经生成，封面失败也不应该让 App 看不到正文。</p>',
      imagePrompt: 'A clean editorial cover',
      coverTitle: ['先保住', '已经写好', '的文章'],
      coverSubtitle: '失败可恢复',
    };

    vi.mocked(listUnprocessedFiles).mockResolvedValue([fileKey]);
    vi.mocked(createPresignedDownloadUrl).mockResolvedValue('https://r2.example.test/audio.mp3');
    vi.mocked(transcribeAudioUrl).mockResolvedValue('今天我想说说失败恢复。');
    vi.mocked(processAudioText).mockResolvedValue(article);
    vi.mocked(generateWechatCoverBuffer).mockRejectedValue(new Error('cover generation timeout'));
    vi.mocked(uploadTranscript).mockResolvedValue();
    vi.mocked(deleteFile).mockResolvedValue();

    await expect(main()).resolves.toBeUndefined();

    const fetchCalls = statusUpdateBodies();
    expect(fetchCalls).toContainEqual(expect.objectContaining({
      filename,
      status: 'PROCESSING',
      articleTitle: article.title,
      articleContent: article.content,
      processingStage: 'ARTICLE_READY',
    }));
    expect(fetchCalls).toContainEqual(expect.objectContaining({
      filename,
      status: 'COMPLETED',
      articleTitle: article.title,
      articleContent: article.content,
      processingStage: 'DRAFT_FAILED',
      errorMessage: expect.stringContaining('cover generation timeout'),
    }));
    expect(fetchCalls.some(call =>
      call.status === 'FAILED' &&
        call.filename === filename
    )).toBe(false);
    expect(publishDraft).not.toHaveBeenCalled();
  });

  it('should process a voice article revision by updating the existing WeChat draft', async () => {
    const revisionRequestKey = 'revision-requests/VibePub-2026-07-02-160000-0m18s-Test/rev-1.json';
    const audioKey = 'revision-requests/VibePub-2026-07-02-160000-0m18s-Test/rev-1.m4a';
    const transcriptKey = 'transcripts/VibePub-2026-07-02-160000-0m18s-Test.json';
    const filename = 'VibePub-2026-07-02-160000-0m18s-Test.m4a';
    const revisedArticle = {
      title: '新版标题',
      content: '<p>这是按语音要求改过的新版正文。</p>',
      imagePrompt: 'A clean editorial cover',
      coverTitle: ['新版', '标题'],
      coverSubtitle: '修改已应用',
    };

    process.env.REVISION_REQUEST_KEY = revisionRequestKey;
    vi.mocked(downloadFile).mockImplementation(async (key) => {
      if (key === revisionRequestKey) {
        return Buffer.from(JSON.stringify({
          revisionId: 'rev-1',
          filename,
          transcriptKey,
          audioKey,
          createdAt: '2026-07-02T08:00:00.000Z',
        }));
      }
      if (key === transcriptKey) {
        return Buffer.from(JSON.stringify({
          rawText: '原始口述',
          articleTitle: '旧标题',
          articleContent: '<p>旧正文</p>',
          wechatDraftId: 'MEDIA_ID_OLD',
          revisionHistory: [{ revisionId: 'old-rev' }],
        }));
      }
      throw new Error(`unexpected key ${key}`);
    });
    vi.mocked(createPresignedDownloadUrl).mockResolvedValue('https://r2.example.test/revision.m4a');
    vi.mocked(transcribeAudioUrl).mockResolvedValue('把标题换得更直接，并补充一个结论。');
    vi.mocked(reviseArticleWithInstruction).mockResolvedValue(revisedArticle);
    vi.mocked(generateWechatCoverBuffer).mockResolvedValue(Buffer.from('revised-cover'));
    vi.mocked(uploadCoverImage).mockResolvedValue();
    vi.mocked(getAccessToken).mockResolvedValue('wechat-token');
    vi.mocked(updateDraft).mockResolvedValue();
    vi.mocked(uploadTranscript).mockResolvedValue();

    await expect(main()).resolves.toBeUndefined();

    expect(listUnprocessedFiles).not.toHaveBeenCalled();
    expect(transcribeAudioUrl).toHaveBeenCalledWith('https://r2.example.test/revision.m4a', 'm4a');
    expect(reviseArticleWithInstruction).toHaveBeenCalledWith({
      rawText: '原始口述',
      currentTitle: '旧标题',
      currentContent: '<p>旧正文</p>',
      instructionText: '把标题换得更直接，并补充一个结论。',
    });
    expect(updateDraft).toHaveBeenCalledWith(
      'wechat-token',
      'MEDIA_ID_OLD',
      revisedArticle.title,
      revisedArticle.content,
      Buffer.from('revised-cover'),
      testWechatConfig,
    );
    expect(uploadTranscript).toHaveBeenCalledWith(
      transcriptKey,
      expect.stringContaining('"instructionText": "把标题换得更直接，并补充一个结论。"'),
    );

    const fetchCalls = statusUpdateBodies();
    expect(fetchCalls.map(call => call.processingStage)).toEqual([
      'ASR',
      'REWRITING',
      'ARTICLE_READY',
      'DRAFTING',
      'COMPLETED',
    ]);
    expect(fetchCalls.at(-1)).toMatchObject({
      filename,
      status: 'COMPLETED',
      articleTitle: revisedArticle.title,
      articleContent: revisedArticle.content,
      processingStage: 'COMPLETED',
      wechatDraftId: 'MEDIA_ID_OLD',
      errorMessage: null,
    });
  });

  it('should generate and insert article images requested by a voice revision', async () => {
    const revisionRequestKey = 'revision-requests/VibePub-2026-07-02-160000-0m18s-Test/rev-image.json';
    const audioKey = 'revision-requests/VibePub-2026-07-02-160000-0m18s-Test/rev-image.m4a';
    const transcriptKey = 'transcripts/VibePub-2026-07-02-160000-0m18s-Test.json';
    const filename = 'VibePub-2026-07-02-160000-0m18s-Test.m4a';
    const revisedArticle = {
      title: '带配图的新版标题',
      content: '<p>第一段正文。</p><p>第二段正文。</p>',
      imagePrompt: 'A clean editorial cover',
      coverTitle: ['带配图', '新版'],
      imageActions: [
        {
          imageId: 'opening-desk',
          kind: 'insert_image' as const,
          prompt: 'A warm desk with a recorder, no text',
          alt: '办公桌上的录音设备',
          anchor: { position: 'after' as const, paragraphIndex: 1 },
        },
      ],
    };

    process.env.REVISION_REQUEST_KEY = revisionRequestKey;
    vi.mocked(downloadFile).mockImplementation(async (key) => {
      if (key === revisionRequestKey) {
        return Buffer.from(JSON.stringify({
          revisionId: 'rev-image',
          filename,
          transcriptKey,
          audioKey,
        }));
      }
      if (key === transcriptKey) {
        return Buffer.from(JSON.stringify({
          rawText: '原始口述',
          articleTitle: '旧标题',
          articleContent: '<p>旧正文</p>',
          wechatDraftId: 'MEDIA_ID_OLD',
          revisionHistory: [],
        }));
      }
      throw new Error(`unexpected key ${key}`);
    });
    vi.mocked(createPresignedDownloadUrl).mockResolvedValue('https://r2.example.test/revision.m4a');
    vi.mocked(transcribeAudioUrl).mockResolvedValue('在第一段后面加一张办公桌录音的图。');
    vi.mocked(reviseArticleWithInstruction).mockResolvedValue(revisedArticle);
    vi.mocked(prepareArticleImages).mockResolvedValue([
      {
        ...revisedArticle.imageActions[0],
        r2Key: 'article-images/VibePub-2026-07-02-160000-0m18s-Test/opening-desk.png',
        publicUrl: 'https://vibepub.example.test/api/files/article-images%2Fopening-desk.png',
        buffer: Buffer.from('article-image'),
      },
    ]);
    vi.mocked(uploadWechatArticleImage).mockResolvedValue('https://mmbiz.qpic.cn/article-image.png');
    vi.mocked(generateWechatCoverBuffer).mockResolvedValue(Buffer.from('revised-cover'));
    vi.mocked(uploadCoverImage).mockResolvedValue();
    vi.mocked(getAccessToken).mockResolvedValue('wechat-token');
    vi.mocked(updateDraft).mockResolvedValue();
    vi.mocked(uploadTranscript).mockResolvedValue();

    await expect(main()).resolves.toBeUndefined();

    expect(prepareArticleImages).toHaveBeenCalledWith('inbox/VibePub-2026-07-02-160000-0m18s-Test.m4a', revisedArticle.imageActions);
    expect(uploadWechatArticleImage).toHaveBeenCalledWith('wechat-token', Buffer.from('article-image'), testWechatConfig);
    expect(updateDraft).toHaveBeenCalledWith(
      'wechat-token',
      'MEDIA_ID_OLD',
      revisedArticle.title,
      expect.stringContaining('https://mmbiz.qpic.cn/article-image.png'),
      Buffer.from('revised-cover'),
      testWechatConfig,
    );
    expect(updateDraft).toHaveBeenCalledWith(
      'wechat-token',
      'MEDIA_ID_OLD',
      revisedArticle.title,
      expect.stringMatching(/第一段正文。<\/p><figure[\s\S]+第二段正文。/),
      Buffer.from('revised-cover'),
      testWechatConfig,
    );
    const transcriptPayload = String(vi.mocked(uploadTranscript).mock.calls.at(-1)?.[1]);
    expect(transcriptPayload).toContain('"articleImages"');
    expect(transcriptPayload).toContain('"wechatUrl": "https://mmbiz.qpic.cn/article-image.png"');
  });
});
