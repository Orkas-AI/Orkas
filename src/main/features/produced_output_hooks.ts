import * as path from 'node:path';

export interface ProducedOutputContext {
  userId?: string;
  cid?: string;
  projectId?: string;
  source?: string;
}

export interface ProducedArtifactContext extends ProducedOutputContext {
  artifactId: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface ProducedOutputHooks {
  finalizeFile?: (absPath: string, context: ProducedOutputContext) => MaybePromise<void>;
  prepareFileInput?: (absPath: string, context: ProducedOutputContext) => MaybePromise<void>;
  finalizeArtifact?: (artifactDir: string, context: ProducedArtifactContext) => MaybePromise<void>;
  documentFooterText?: (context: ProducedOutputContext) => string | null;
}

let hooks: ProducedOutputHooks = {};

export function registerProducedOutputHooks(next: ProducedOutputHooks): () => void {
  const previous = hooks;
  hooks = {
    ...hooks,
    ...next,
  };
  return () => {
    if (hooks.finalizeFile === next.finalizeFile) hooks.finalizeFile = previous.finalizeFile;
    if (hooks.prepareFileInput === next.prepareFileInput) hooks.prepareFileInput = previous.prepareFileInput;
    if (hooks.finalizeArtifact === next.finalizeArtifact) hooks.finalizeArtifact = previous.finalizeArtifact;
    if (hooks.documentFooterText === next.documentFooterText) hooks.documentFooterText = previous.documentFooterText;
  };
}

export async function prepareProducedFileForInput(
  absPath: string,
  context: ProducedOutputContext = {},
): Promise<void> {
  if (!hooks.prepareFileInput) return;
  await hooks.prepareFileInput(path.resolve(absPath), context);
}

export async function finalizeProducedFile(absPath: string, context: ProducedOutputContext = {}): Promise<void> {
  const key = path.resolve(absPath);
  if (hooks.finalizeFile) await hooks.finalizeFile(key, context);
}

export async function finalizeProducedArtifact(
  artifactDir: string,
  context: ProducedArtifactContext,
): Promise<void> {
  if (!hooks.finalizeArtifact) return;
  await hooks.finalizeArtifact(artifactDir, context);
}

export function producedDocumentFooterText(context: ProducedOutputContext = {}): string | null {
  return hooks.documentFooterText?.(context) || null;
}
