import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  chatMediaLocalPathFromUrl,
  chatMediaCidUrl,
  chatMediaLocalUrl,
  versionChatMediaLocalUrlsInText,
  versionedChatMediaLocalUrl,
} from '../../../src/main/util/chat-media-url';

describe('util/chat-media-url', () => {
  it.each([
    ['bold video', '**', '.mp4', '?v=old', '后续说明', 'video'],
    ['unversioned bold video', '**', '.mp4', '', '', 'video'],
    ['italic image', '*', '.png', '?v=old', '', 'img'],
    ['underscored audio', '__', '.wav', '?download=1&v=old#preview', '', 'audio'],
    ['struck video', '~~', '.mp4', '?v=old', '', 'video'],
  ])('keeps the %s renderable when refreshing its URL', (_label, emphasis, ext, query, prose, tag) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-media-markdown-'));
    const file = path.join(dir, `成片 (final)!${ext}`);
    try {
      fs.writeFileSync(file, 'media');
      const base = chatMediaLocalUrl(file);
      const source = `${emphasis}[Result](${base}${query})${emphasis}${prose}`;
      const output = versionChatMediaLocalUrlsInText(source);
      const expected = new URL(versionedChatMediaLocalUrl(file));
      if (query.includes('download')) { expected.searchParams.set('download', '1'); expected.hash = 'preview'; }
      const destination = /\[Result\]\(([^)]+)\)/.exec(output)?.[1];
      expect(destination).toBeDefined();
      expect(path.normalize(chatMediaLocalPathFromUrl(destination!))).toBe(path.normalize(file));
      expect(new URL(destination!).searchParams.get('v')).toBe(expected.searchParams.get('v'));
      expect(new URL(destination!).searchParams.get('download')).toBe(expected.searchParams.get('download'));
      expect(new URL(destination!).hash).toBe(expected.hash);
      expect(output).toBe(`${emphasis}[Result](${destination})${emphasis}${prose}`);
      const { renderMarkdown } = require('../../../src/renderer/modules/utils.js');
      expect(renderMarkdown(output)).toContain(`<${tag}`);
      expect(versionChatMediaLocalUrlsInText(output)).toBe(output);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves adjacent links, titles and literal query punctuation without consuming surrounding prose', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-media-boundaries-'));
    const file = path.join(dir, 'video.mp4');
    try {
      fs.writeFileSync(file, 'media');
      const base = chatMediaLocalUrl(file);
      const current = versionedChatMediaLocalUrl(file);
      const source = `**[One](${base}?v=old "Preview")**后续[Two](${base}?v=old)_尾注_`;
      expect(versionChatMediaLocalUrlsInText(source)).toBe(
        `**[One](${current} "Preview")**后续[Two](${current})_尾注_`,
      );
      const bare = versionChatMediaLocalUrlsInText(`${base}?note=literal*`);
      expect(new URL(bare).searchParams.get('note')).toBe('literal*');
      const missing = `**[Missing](${chatMediaLocalUrl(path.join(dir, 'missing.mp4'))}?v=old)**`;
      expect(versionChatMediaLocalUrlsInText(missing)).toBe(missing);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds metadata work for repeated references without caching stale file state between renders', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-reference-cost-'));
    const file = path.join(root, 'notes.md');
    fs.writeFileSync(file, 'old');
    const stat = vi.spyOn(fs, 'statSync');
    const realpath = vi.spyOn(fs, 'realpathSync');
    const read = vi.spyOn(fs, 'readFileSync');
    syncBuiltinESMExports();
    const resetCounts = () => { stat.mockClear(); realpath.mockClear(); read.mockClear(); };
    const metadataCalls = () => stat.mock.calls.length + realpath.mock.calls.length;
    try {
      const source = Array.from({ length: 100 }, (_, i) => `[note](notes.md:${i + 1})`).join('\n');
      const result = versionChatMediaLocalUrlsInText(source, root);
      expect(result.match(/chat-media:\/\/local\//g)).toHaveLength(100);
      expect(result).toContain('#L100');
      // An I/O budget protects history loading on slow disks. It scales with
      // distinct files, not the number of references; file contents are unused.
      expect(metadataCalls()).toBeLessThanOrEqual(6);
      expect(read).not.toHaveBeenCalled();

      resetCounts();
      const missing = '[missing](deep/missing/notes.md:21)\n'.repeat(100);
      expect(versionChatMediaLocalUrlsInText(missing, root)).toBe(missing);
      expect(metadataCalls()).toBeLessThanOrEqual(2);
      expect(read).not.toHaveBeenCalled();

      resetCounts();
      const outside = '[outside](../../outside/notes.md:21)\n'.repeat(100);
      expect(versionChatMediaLocalUrlsInText(outside, root)).toBe(outside);
      expect(versionChatMediaLocalUrlsInText('Plain prose without links.\n'.repeat(1000), root))
        .toBe('Plain prose without links.\n'.repeat(1000));
      expect(metadataCalls()).toBe(0);
      expect(read).not.toHaveBeenCalled();
      const unfinished = `${'['.repeat(10000)}](notes.md\n${'['.repeat(10000)}\n[unfinished](`;
      expect(versionChatMediaLocalUrlsInText(unfinished, root)).toBe(unfinished);
      expect(metadataCalls()).toBe(0);

      fs.writeFileSync(file, 'replacement contents');
      expect(versionChatMediaLocalUrlsInText(source, root)).not.toBe(result);
      fs.unlinkSync(file);
      expect(versionChatMediaLocalUrlsInText(source, root)).toBe(source);
      fs.mkdirSync(path.join(root, 'deep', 'missing'), { recursive: true });
      fs.writeFileSync(path.join(root, 'deep', 'missing', 'notes.md'), 'Restored');
      expect(versionChatMediaLocalUrlsInText(missing, root).match(/chat-media:\/\/local\//g)).toHaveLength(100);
    } finally {
      stat.mockRestore(); realpath.mockRestore(); read.mockRestore();
      syncBuiltinESMExports();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds Markdown-safe conversation attachment URLs', () => {
    expect(chatMediaCidUrl('conversation #1', 'generated (final)!.png')).toBe(
      'chat-media://cid/conversation%20%231/generated%20%28final%29%21.png',
    );
  });

  it('encodes every filename segment without encoding path separators', () => {
    expect(chatMediaLocalUrl('/Users/user/frames/hero #1?.png')).toBe(
      'chat-media://local/Users/user/frames/hero%20%231%3F.png',
    );
    expect(chatMediaLocalUrl('/Users/user/100%/中文 图.png')).toBe(
      'chat-media://local/Users/user/100%25/%E4%B8%AD%E6%96%87%20%E5%9B%BE.png',
    );
  });

  it('normalizes Windows separators while preserving the drive prefix', () => {
    expect(chatMediaLocalUrl('C:\\Users\\user\\frame #1.png')).toBe(
      'chat-media://local/C:/Users/user/frame%20%231.png',
    );
  });

  it('escapes Markdown delimiter characters inside path segments', () => {
    expect(chatMediaLocalUrl('/Users/user/final (approved)!*.png')).toBe(
      'chat-media://local/Users/user/final%20%28approved%29%21%2A.png',
    );
  });

  it('decodes only local media URLs without exposing attachment routes', () => {
    expect(chatMediaLocalPathFromUrl(
      'chat-media://local/Users/user/hero%20%231%3F.png',
      'darwin',
    )).toBe('/Users/user/hero #1?.png');
    expect(chatMediaLocalPathFromUrl(
      'chat-media://local/C:/Users/user/frame.png',
      'win32',
    )).toBe('C:/Users/user/frame.png');
    expect(chatMediaLocalPathFromUrl('chat-media://cid/c1/frame.png')).toBe('');
  });

  it('changes generated-media URLs when the file at the same path changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-chat-media-version-'));
    const file = path.join(dir, 'preview.png');
    try {
      fs.writeFileSync(file, 'old');
      const oldUrl = versionedChatMediaLocalUrl(file);
      fs.writeFileSync(file, 'new-preview-bytes');
      const newUrl = versionedChatMediaLocalUrl(file);

      expect(oldUrl).toMatch(/\?v=\d+-\d+-3$/);
      expect(newUrl).toMatch(/\?v=\d+-\d+-17$/);
      expect(newUrl).not.toBe(oldUrl);
      expect(path.normalize(chatMediaLocalPathFromUrl(newUrl, process.platform))).toBe(path.normalize(file));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('versions unversioned local URLs embedded in Markdown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-chat-media-text-'));
    const file = path.join(dir, 'poster.png');
    try {
      fs.writeFileSync(file, 'poster');
      const base = chatMediaLocalUrl(file);
      const normalized = versionChatMediaLocalUrlsInText(`Here: ![poster](${base}).`);

      expect(normalized).toMatch(/!\[poster\]\(chat-media:\/\/local\/.+\?v=\d+-\d+-6\)\.$/);
      expect(normalized).not.toContain(`(${base})`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes every supported assistant media destination to one versioned URL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-chat-media-aliases-'));
    const file = path.join(dir, 'final.mp4');
    try {
      fs.writeFileSync(file, 'final-video');
      const canonical = versionedChatMediaLocalUrl(file);
      const aliases = [
        chatMediaLocalUrl(file),
        `sandbox:${file}`,
        pathToFileURL(file).toString(),
        file,
      ];
      const text = aliases.map((url, index) => `[video-${index}](${url})`).join('\n');

      const normalized = versionChatMediaLocalUrlsInText(text);

      expect(normalized.match(new RegExp(canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(4);
      expect(normalized).not.toContain('sandbox:');
      expect(normalized).not.toContain('file://');
      expect(normalized).toMatch(/\?v=\d+-\d+-11/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recomputes the persisted destination after bytes at the same path are overwritten', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-chat-media-overwrite-'));
    const file = path.join(dir, 'final.mp4');
    try {
      fs.writeFileSync(file, 'old');
      const before = versionChatMediaLocalUrlsInText(`[video](sandbox:${file})`);

      fs.writeFileSync(file, 'replacement-video');
      const after = versionChatMediaLocalUrlsInText(`[video](sandbox:${file})`);

      expect(before).toMatch(/\?v=\d+-\d+-3\)$/);
      expect(after).toMatch(/\?v=\d+-\d+-17\)$/);
      expect(after).not.toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not reinterpret prose, remote URLs, or non-media destinations as local media', () => {
    const absText = path.join(os.tmpdir(), 'notes.txt');
    const text = [
      `Keep this path verbatim: ${absText}`,
      `[notes](sandbox:${absText})`,
      '[remote](https://example.test/final.mp4)',
      '`[quoted](sandbox:/tmp/quoted.mp4)`',
    ].join('\n');

    expect(versionChatMediaLocalUrlsInText(text)).toBe(text);
  });

  it('refreshes an older version while preserving other query parameters and fragments', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-chat-media-refresh-'));
    const file = path.join(dir, 'poster.png');
    try {
      fs.writeFileSync(file, 'new-poster');
      const base = chatMediaLocalUrl(file);
      const normalized = versionChatMediaLocalUrlsInText(
        `[poster](${base}?download=1&v=old#preview)`,
      );

      expect(normalized).toContain('download=1');
      expect(normalized).toMatch(/v=\d+-\d+-10/);
      expect(normalized).toContain('#preview');
      expect(normalized).not.toContain('v=old');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves missing local files and non-local media URLs unchanged', () => {
    const missing = chatMediaLocalUrl(path.join(os.tmpdir(), 'orkas-missing-poster.png'));
    const text = `${missing} chat-media://cid/c1/poster.png https://example.test/poster.png`;
    expect(versionChatMediaLocalUrlsInText(text)).toBe(text);
  });

  it('resolves media an agent offered by a path relative to its own workspace', () => {
    // An agent hands over the path it was given, and for files it produced in
    // its cwd that is a relative one. The renderer upgrades a media
    // destination to an <img>/<video> but has no base directory, so it
    // requested the path against the app origin: on 2026-09-01 eight keyframes
    // offered for approval all rendered as "image missing" while sitting on
    // disk, next to a contact sheet that displayed because a tool had emitted
    // it as an absolute URL.
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-chat-media-relative-'));
    try {
      const frame = path.join(ws, 'project', 'composition', 'preview', '01-first-frame.png');
      fs.mkdirSync(path.dirname(frame), { recursive: true });
      fs.writeFileSync(frame, 'frame-bytes');
      const notes = path.join(ws, 'project', 'notes.txt');
      fs.writeFileSync(notes, 'plain text');
      const outside = path.join(path.dirname(ws), `orkas-outside-${path.basename(ws)}.png`);
      fs.writeFileSync(outside, 'outside');

      const normalized = versionChatMediaLocalUrlsInText([
        '[first frame](project/composition/preview/01-first-frame.png)',
        '![sheet](./project/composition/preview/01-first-frame.png)',
      ].join('\n'), ws);

      expect(normalized).toContain(versionedChatMediaLocalUrl(frame));
      expect(normalized.match(/chat-media:\/\/local\//g)).toHaveLength(2);
      expect(normalized).toMatch(/\?v=\d+-\d+-11/);

      // Nothing else becomes a local embed: a relative path that names no
      // file, a remote URL, a fragment, and a traversal out
      // of the workspace all keep their original text.
      const untouched = [
        '[gone](project/composition/preview/99-missing.png)',
        '[remote](https://example.test/hero.png)',
        '[anchor](#section.png)',
        `[escape](../${path.basename(outside)})`,
      ].join('\n');
      expect(versionChatMediaLocalUrlsInText(untouched, ws)).toBe(untouched);
      expect(versionChatMediaLocalUrlsInText('[notes](project/notes.txt)', ws))
        .toBe(`[notes](${versionedChatMediaLocalUrl(notes)})`);

      // Without a base directory the relative destination is not guessed at.
      expect(versionChatMediaLocalUrlsInText('[first frame](project/composition/preview/01-first-frame.png)'))
        .toBe('[first frame](project/composition/preview/01-first-frame.png)');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('makes only existing workspace document links previewable, with source locations separate from path bytes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-document-links-'));
    const ws = path.join(root, 'workspace');
    fs.mkdirSync(ws);
    const file = path.join(ws, '旧稿 (1).md');
    const outside = path.join(root, 'outside', 'outside.md');
    fs.mkdirSync(path.dirname(outside));
    fs.writeFileSync(file, '# Existing document');
    fs.writeFileSync(outside, 'Outside');
    fs.symlinkSync(path.dirname(outside), path.join(ws, 'linked'), 'junction');
    try {
      for (const location of [':21', ':21:5', '#L21', '#L21C5', '#L21-L25']) {
        const result = versionChatMediaLocalUrlsInText(`[source](<旧稿 (1).md${location}>)`, ws);
        const destination = /\[source\]\(([^)]+)\)/.exec(result)![1];
        expect(path.normalize(chatMediaLocalPathFromUrl(destination)!)).toBe(path.normalize(file));
        expect(destination).toContain('#L21');
        expect(result).toContain('[source]');
      }
      for (const target of ['../outside/outside.md', 'linked/outside.md', 'missing.md', 'https://example.test/notes.md', '#section']) {
        const source = `[source](${target})`;
        expect(versionChatMediaLocalUrlsInText(source, ws)).toBe(source);
      }
      const link = '[source](<旧稿 (1).md:21>)';
      for (const example of [`\`${link}\``, `\`\` literal \` ${link} \`\``, `\`\`\`\`markdown\n${link}\n\`\`\`\``]) {
        expect(versionChatMediaLocalUrlsInText(example, ws)).toBe(example);
      }
      expect(versionChatMediaLocalUrlsInText(link)).toBe(link);
      expect(versionChatMediaLocalUrlsInText('旧稿 (1).md:21', ws)).toBe('旧稿 (1).md:21');
      const literal = path.join(ws, 'literal.md:21');
      if (process.platform !== 'win32') {
        fs.writeFileSync(literal, 'Literal colon');
        expect(versionChatMediaLocalUrlsInText('[literal](literal.md%3A21)', ws))
          .toBe(`[literal](${versionedChatMediaLocalUrl(literal)})`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
