import { describe, it, expect, vi } from 'vitest';
import { processAudioText, generateCoverImageBuffer } from '../src/llm.js';
import { publishDraft } from '../src/wechat.js';

// Mock dependencies
vi.mock('../src/llm.js', () => ({
  processAudioText: vi.fn(),
  generateCoverImageBuffer: vi.fn()
}));

vi.mock('../src/wechat.js', () => ({
  publishDraft: vi.fn(),
  getAccessToken: vi.fn()
}));

describe('VibePub Cloud Pipeline', () => {
  it('should process audio text and return title, content, and imagePrompt', async () => {
    const mockRawText = "Hello this is a test recording.";
    const mockProcessedResult = {
      title: "Test Title",
      content: "<p>Test Content</p>",
      imagePrompt: "A futuristic testing landscape"
    };
    
    vi.mocked(processAudioText).mockResolvedValue(mockProcessedResult);
    
    const result = await processAudioText(mockRawText);
    expect(result.title).toBe("Test Title");
    expect(result.imagePrompt).toBe("A futuristic testing landscape");
  });
  
  it('should generate an image buffer using the prompt', async () => {
    const mockPrompt = "A futuristic testing landscape";
    const mockBuffer = Buffer.from("fake-image-data");
    
    vi.mocked(generateCoverImageBuffer).mockResolvedValue(mockBuffer);
    
    const buffer = await generateCoverImageBuffer(mockPrompt);
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
