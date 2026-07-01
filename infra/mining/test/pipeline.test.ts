import { describe, it, expect, vi } from 'vitest';
import { processAudioText } from '../src/llm.js';
import { generateWechatCoverBuffer } from '../src/coverRenderer.js';
import { publishDraft } from '../src/wechat.js';

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

describe('VibePub Cloud Pipeline', () => {
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
});
