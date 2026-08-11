const DIRECT_OCR_INTENT =
  /\bocr\b|文字识别|扫描(?:件|文档|版\s*pdf)|图片型\s*pdf|逐字(?:转写|抄录)/i;
const OCR_ACTION = /识别|提取|转写|抄录/i;
const OCR_MEDIA = /图片|图中|截图|扫描件|扫描文档/i;
const OCR_TEXT_TARGET = /文字|文本|内容|字符|表格/i;

export interface OcrToolPolicyInput {
  userMessage?: string;
  attachmentTypes?: readonly string[];
  conversationAttachmentNames?: readonly string[];
  visionAvailable: boolean;
}

function hasKind(values: readonly string[] | undefined, kind: 'pdf' | 'image'): boolean {
  return !!values?.some((value) => String(value).trim().toLowerCase() === kind);
}

function hasExtension(names: readonly string[] | undefined, extensions: readonly string[]): boolean {
  return !!names?.some((name) => extensions.some((ext) => String(name).toLowerCase().endsWith(ext)));
}

/**
 * Keep local OCR as a specialized capability instead of a default temptation
 * on every image task. It remains available for scanned-PDF workflows,
 * explicit OCR requests, and image input routed to a model that cannot receive
 * images.
 */
export function shouldExposeOcrFileTool(input: OcrToolPolicyInput): boolean {
  const userMessage = String(input.userMessage || '');
  const hasComposedOcrIntent = OCR_ACTION.test(userMessage)
    && OCR_MEDIA.test(userMessage)
    && OCR_TEXT_TARGET.test(userMessage);
  if (
    DIRECT_OCR_INTENT.test(userMessage)
    || hasComposedOcrIntent
    || /\.pdf(?:\b|$)/i.test(userMessage)
  ) {
    return true;
  }

  const hasCurrentAttachments = !!input.attachmentTypes?.length;
  if (hasKind(input.attachmentTypes, 'pdf')) return true;
  if (!hasCurrentAttachments && hasExtension(input.conversationAttachmentNames, ['.pdf'])) return true;

  const hasImage = hasKind(input.attachmentTypes, 'image')
    || (!hasCurrentAttachments
      && hasExtension(input.conversationAttachmentNames, ['.png', '.jpg', '.jpeg', '.webp', '.gif']));
  return hasImage && !input.visionAvailable;
}
