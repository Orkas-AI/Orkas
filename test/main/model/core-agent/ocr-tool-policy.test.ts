import { describe, expect, it } from 'vitest';
import { shouldExposeOcrFileTool } from '../../../../src/main/model/core-agent/ocr-tool-policy';

describe('ocr tool exposure policy', () => {
  it.each([
    {
      scenario: 'an ordinary image comparison on a vision model',
      input: {
        userMessage: '这张图里的三种客座有什么区别？',
        attachmentTypes: ['image'],
        visionAvailable: true,
      },
    },
    {
      scenario: 'an Office task that only embeds an image',
      input: {
        userMessage: '把这张截图插入周报并加一个标题',
        attachmentTypes: ['image'],
        visionAvailable: true,
      },
    },
    {
      scenario: 'an editable Office document task without visual input',
      input: {
        userMessage: '把季度总结整理成 docx',
        attachmentTypes: ['docx'],
        visionAvailable: true,
      },
    },
  ])('does not expose OCR for $scenario', ({ input }) => {
    expect(shouldExposeOcrFileTool(input)).toBe(false);
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

  it.each([
    '请 OCR 这张截图并逐字转写',
    '识别一下这张截图里的文字',
    '请从这张截图中提取表格文字',
    '把图片里的表格内容识别出来',
  ])('exposes OCR for explicit text-recognition intent: %s', (userMessage) => {
    expect(shouldExposeOcrFileTool({
      userMessage,
      attachmentTypes: ['image'],
      visionAvailable: true,
    })).toBe(true);
  });

  it('keeps explicit OCR visible when a new image follows an earlier PDF', () => {
    expect(shouldExposeOcrFileTool({
      userMessage: '把这张截图里的文字识别出来',
      attachmentTypes: ['image'],
      conversationAttachmentNames: ['earlier-scan.pdf', 'new-image.png'],
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
});
