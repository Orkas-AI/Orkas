import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function publishedVoiceFiles(
  messages: readonly any[],
  linkScope?: { root: string; actorId: string; projectLinks?: boolean },
): string[] {
  const visible = messages.filter(message => message.from && message.from !== 'user' && !message.dispatch && !message.deleted_at);
  const attachments = visible
    .flatMap(message=>Array.isArray(message.produced)?message.produced:[])
    .filter(file=>typeof file==='string'&&path.isAbsolute(file));
  if (!linkScope) return attachments;
  const reply = visible.filter(message => message.from === linkScope.actorId).at(-1)?.text;
  if (typeof reply !== 'string' || !reply.includes('](')) return attachments;

  const { chatMediaLocalPathFromUrl } = require('../../../src/main/util/chat-media-url.ts') as typeof import('../../../src/main/util/chat-media-url');
  const { splitMarkdownProseCode } = require('../../../src/main/util/markdown-prose-code.ts') as typeof import('../../../src/main/util/markdown-prose-code');
  const { resolveLocalMediaPath } = require('../../../src/main/features/chat_attachments.ts') as typeof import('../../../src/main/features/chat_attachments');
  const links: string[] = [];
  for (const segment of splitMarkdownProseCode(reply)) {
    if (segment.kind !== 'prose') continue;
    for (const match of segment.text.matchAll(/(?<![!\\])\[[^\]\r\n]+\]\((<[^<>\r\n]+>|[^\s)]+)(?:\s+"[^"\r\n]*")?\)/g)) {
      const destination = match[1].startsWith('<') ? match[1].slice(1, -1) : match[1];
      if (/^chat-media:\/\/local\//i.test(destination)) {
        links.push(chatMediaLocalPathFromUrl(destination));
      } else if (linkScope.projectLinks && /\.json$/i.test(destination) && path.isAbsolute(destination) && !/^[\\/]{2}/.test(destination)) {
        links.push(destination);
      }
    }
  }
  const linked = scopedPublishedVoiceFiles(linkScope.root, links).filter(file => {
    if (linkScope.projectLinks && /\.json$/i.test(file)) {
      // File buttons open JSON through produced.readText. The per-case checks
      // still verify project content and, where required, replay against audio.
      if (path.basename(file) === 'plan-snapshot.json') return false;
      try { return fs.statSync(file).size <= 2 * 1024 * 1024; } catch { return false; }
    }
    const resolved = resolveLocalMediaPath(file);
    return resolved.ok && resolved.kind === 'audio';
  });
  const attachedPaths = new Set(linked.length ? scopedPublishedVoiceFiles(linkScope.root, attachments) : []);
  return [...new Set([...attachments, ...linked.filter(file => !attachedPaths.has(file))])];
}

/** Resolve a delivered file without scanning drafts or accepting another workspace's bytes. */
export function scopedPublishedVoiceFiles(root: string, published: readonly string[]): string[] {
  let scope: string;
  try { scope = fs.realpathSync(root); } catch { return []; }
  const files = new Set<string>();
  for (const candidate of new Set(published)) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      if (!fs.lstatSync(candidate).isFile()) continue;
      const file = fs.realpathSync(candidate);
      const relative = path.relative(scope, file);
      if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) continue;
      if (relative.split(path.sep).some(part => part.startsWith('.') || part === 'sources' || part === 'export-previous')) continue;
      files.add(file);
    } catch { /* Stale or unreadable attachments cannot be delivered evidence. */ }
  }
  return [...files];
}

/** Select candidates using independently resolved delivery paths. */
export function publishedVoiceCandidates(candidates: readonly string[], published?: readonly string[]): string[] {
  if (published === undefined) return [...candidates];
  const attached = new Set<string>();
  for (const file of published) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) continue;
    try { if (fs.statSync(file).isFile()) attached.add(fs.realpathSync(file)); } catch {}
  }
  return candidates.filter(file => {
    try { return attached.has(fs.realpathSync(file)); } catch { return false; }
  });
}
