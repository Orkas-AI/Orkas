import fs from 'node:fs';
import path from 'node:path';

export function publishedVoiceFiles(messages: readonly any[]): string[] {
  return messages.filter(message=>message.from&&message.from!=='user'&&!message.dispatch&&!message.deleted_at)
    .flatMap(message=>Array.isArray(message.produced)?message.produced:[])
    .filter(file=>typeof file==='string'&&path.isAbsolute(file));
}

/** Select host-attached candidates, never paths inferred from reply prose. */
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
