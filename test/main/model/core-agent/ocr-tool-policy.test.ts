import { describe, expect, it } from 'vitest';
import { shouldExposeOcrFileTool } from '../../../../src/main/model/core-agent/ocr-tool-policy';

describe('ocr tool exposure policy', () => {
  it('does not expose OCR for an ordinary image task on a vision model', () => {
    expect(shouldExposeOcrFileTool({
      userMessage: '这张图里的三种客座有什么区别？',
      attachmentTypes: ['image'],
      visionAvailable: true,
    })).toBe(false);
  });

  it('exposes OCR for current or earlier PDF attachments', () => {
    expect(shouldExposeOcrFileTool({
      attachmentTypes: ['pdf'],
      visionAvailable: true,
    })).toBe(true);
    expect(shouldExposeOcrFileTool({
      conversationAttachmentNames: ['earlier-scan.PDF'],
      visionAvailable: true,
    })).toBe(true);
  });

  it('does not let an old PDF make OCR visible for a new ordinary image task', () => {
    expect(shouldExposeOcrFileTool({
      userMessage: '看看这张新图',
      attachmentTypes: ['image'],
      conversationAttachmentNames: ['earlier-scan.pdf', 'new-image.png'],
      visionAvailable: true,
    })).toBe(false);
  });

  it('exposes OCR when the user explicitly requests text recognition', () => {
    expect(shouldExposeOcrFileTool({
      userMessage: '请 OCR 这张截图并逐字转写',
      attachmentTypes: ['image'],
      visionAvailable: true,
    })).toBe(true);
    expect(shouldExposeOcrFileTool({
      userMessage: '识别一下这张截图里的文字',
      attachmentTypes: ['image'],
      visionAvailable: true,
    })).toBe(true);
  });

  it('exposes OCR when a workspace PDF path is named in the request', () => {
    expect(shouldExposeOcrFileTool({
      userMessage: '读取 workspace/invoices/scan.pdf',
      visionAvailable: true,
    })).toBe(true);
  });

  it('exposes OCR for image input when the selected model has no vision', () => {
    expect(shouldExposeOcrFileTool({
      attachmentTypes: ['image'],
      visionAvailable: false,
    })).toBe(true);
  });

  it('keeps OCR available to OfficeWorker document workflows', () => {
    expect(shouldExposeOcrFileTool({
      agentId: 'a19101ba698a',
      visionAvailable: true,
    })).toBe(true);
  });
});
