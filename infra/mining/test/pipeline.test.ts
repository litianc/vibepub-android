import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { processAudioText } from '../src/llm.js';
import { generateWechatCoverBuffer } from '../src/coverRenderer.js';
import { getAccessToken, publishDraft } from '../src/wechat.js';
import { createPresignedDownloadUrl, deleteFile, listUnprocessedFiles, uploadTranscript } from '../src/r2.js';
import { transcribeAudioUrl } from '../src/asr.js';
import { buildArticleTranscriptPayload, filterTargetFiles, main } from '../src/index.js';

// Mock dependencies
vi.mock('../src/llm.js', () => ({
  processAudioText: vi.fn(),
}));

vi.mock('../src/coverRenderer.js', () => ({
  generateWechatCoverBuffer: vi.fn()
}));

vi.mock('../src/wechat.js', () => ({
  publishDraft: vi.fn(),
  getAccessToken: vi.fn()
}));

vi.mock('../src/r2.js', () => ({
  listUnprocessedFiles: vi.fn(),
  createPresignedDownloadUrl: vi.fn(),
  deleteFile: vi.fn(),
  uploadTranscript: vi.fn()
}));

vi.mock('../src/asr.js', () => ({
  transcribeAudioUrl: vi.fn()
}));

describe('VibePub Cloud Pipeline', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      PUBLIC_BASE_URL: 'https://vibepub.example.test',
      FILES_TOKEN: 'test-files-token',
      TARGET_FILENAME: '',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '',
    }));
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
        errorMessage: '公众号草稿创建失败：502',
      },
    );

    expect(payload).toMatchObject({
      rawText: 'raw transcript',
      articleTitle: 'Article title',
      articleContent: '<p>Article body</p>',
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
    vi.mocked(uploadTranscript).mockResolvedValue();
    vi.mocked(deleteFile).mockResolvedValue();

    await expect(main()).resolves.toBeUndefined();

    const fetchCalls = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
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
    });
    expect(fetchCalls).toContainEqual(expect.objectContaining({
      filename,
      status: 'COMPLETED',
      articleTitle: article.title,
      articleContent: article.content,
      processingStage: 'COMPLETED',
      wechatDraftId: 'MEDIA_ID_123',
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
    vi.mocked(uploadTranscript).mockResolvedValue();
    vi.mocked(deleteFile).mockResolvedValue();

    await expect(main()).resolves.toBeUndefined();

    expect(uploadTranscript).toHaveBeenCalledWith(
      'transcripts/VibePub-2026-06-30-044540-0m30s-Debug-Audio-Import.json',
      expect.stringContaining('"processingStage":"DRAFT_FAILED"'),
    );
    expect(deleteFile).toHaveBeenCalledWith(fileKey);

    const fetchCalls = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(fetchCalls).toContainEqual(expect.objectContaining({
      filename,
      status: 'COMPLETED',
      articleTitle: article.title,
      articleContent: article.content,
      processingStage: 'DRAFT_FAILED',
    }));
    expect(fetchCalls.some(call =>
      call.status === 'FAILED' &&
        call.filename === filename
    )).toBe(false);
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

    const fetchCalls = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
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
});
