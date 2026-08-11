import { describe, expect, it } from 'vitest';

import { _nativeEmbedLoadCodeForTests } from '../../../src/main/features/kb_embed';

describe('knowledge-base native embedding diagnostics', () => {
  it('classifies ONNX and tokenizer dlopen failures without exposing paths', () => {
    expect(_nativeEmbedLoadCodeForTests({
      code: 'ERR_DLOPEN_FAILED',
      message: 'Cannot load C:\\Program Files\\Orkas\\onnxruntime_binding.node',
    })).toBe('E_LIBRARY_NATIVE_ONNX_LOAD');
    expect(_nativeEmbedLoadCodeForTests({
      code: 'ERR_DLOPEN_FAILED',
      stack: 'at /Applications/Orkas.app/tokenizers.win32-x64-msvc.node',
    })).toBe('E_LIBRARY_NATIVE_TOKENIZERS_LOAD');
  });

  it('keeps a bounded fallback and ignores unrelated failures', () => {
    expect(_nativeEmbedLoadCodeForTests({
      code: 'ERR_DLOPEN_FAILED',
      message: 'A dependent native library could not be initialized',
    })).toBe('E_LIBRARY_NATIVE_EMBED_LOAD');
    expect(_nativeEmbedLoadCodeForTests({
      code: 'ENOENT',
      message: 'model file missing',
    })).toBe('');
  });
});
