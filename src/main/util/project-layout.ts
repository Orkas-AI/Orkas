import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  userRoot,
  userChatsDir,
  userProjectsDir,
  projectMetaFile,
  projectChatsDir,
  projectChatIndexFile,
  projectChatJsonlFile,
  projectGroupChatDir,
  projectGroupChatMembersFile,
  projectGroupChatStateFile,
  projectGroupChatPlanFile,
  projectGroupChatVisibilityDir,
  projectGroupChatVisibilityFile,
  userSessionsDir,
  userSessionFile,
  sessionCloudToolResultsDir,
  projectSessionsDir,
  projectSessionFile,
  projectSessionCloudToolResultsDir,
  chatAttachmentDir,
  projectChatAttachmentDir,
  chatArtifactCidDir,
  artifactDir,
  projectChatArtifactCidDir,
  projectArtifactDir,
  userAutoTasksDir,
  autoTaskDir,
  autoTaskConfigFile,
  autoTaskAttachmentsDir,
  projectAutoTasksDir,
  projectAutoTaskDir,
  projectAutoTaskConfigFile,
  projectAutoTaskAttachmentsDir,
} from '../paths';
import { readJsonSync, safeId } from '../storage';

const RESERVED_CHAT_DIRS = new Set(['agent', 'skill', 'subagents']);
// `null` is cached briefly: most conversations live in the global root, but a
// conversation can be moved into a newly-created project after a lookup. A
// short negative TTL preserves the main-thread I/O win without pinning stale
// ownership for the rest of the app process.
const NEGATIVE_PROJECT_CACHE_TTL_MS = 2_000;
type ConversationProjectCacheEntry = { projectId: string | null; expiresAt: number };
const conversationProjectCache = new Map<string, Map<string, ConversationProjectCacheEntry>>();

function rememberConversationProject(uid: string, cid: string, pid: string | null): void {
  let byCid = conversationProjectCache.get(uid);
  if (!byCid) {
    byCid = new Map();
    conversationProjectCache.set(uid, byCid);
  }
  byCid.set(cid, {
    projectId: pid,
    expiresAt: pid === null ? Date.now() + NEGATIVE_PROJECT_CACHE_TTL_MS : Number.POSITIVE_INFINITY,
  });
}

export function cloudRelForAbs(uid: string, absPath: string): string {
  return path.relative(userRoot(uid), absPath).split(path.sep).join('/');
}

function readJsonArray(file: string): any[] {
  const data: any = readJsonSync(file);
  return Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : []);
}

export function listProjectIds(uid: string): string[] {
  const root = userProjectsDir(uid);
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeId(entry.name)) continue;
    if (!fs.existsSync(projectMetaFile(uid, entry.name))) continue;
    out.push(entry.name);
  }
  out.sort();
  return out;
}

export function projectExistsForLayout(uid: string, pid: string): boolean {
  return safeId(pid) && fs.existsSync(projectMetaFile(uid, pid));
}

export function listProjectConversationIds(uid: string): string[] {
  const out = new Set<string>();
  for (const pid of listProjectIds(uid)) {
    for (const row of readJsonArray(projectChatIndexFile(uid, pid))) {
      const cid = typeof row?.conversation_id === 'string' ? row.conversation_id : '';
      if (safeId(cid)) out.add(cid);
    }
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(projectChatsDir(uid, pid), { withFileTypes: true }); }
    catch { entries = []; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const cid = entry.name.slice(0, -'.jsonl'.length);
        if (safeId(cid)) out.add(cid);
      } else if (entry.isDirectory() && safeId(entry.name) && !RESERVED_CHAT_DIRS.has(entry.name)) {
        out.add(entry.name);
      }
    }
  }
  return Array.from(out);
}

export function findProjectIdForConversation(uid: string, cid: string): string | null {
  if (!safeId(cid)) return null;
  const cachedByCid = conversationProjectCache.get(uid);
  if (cachedByCid?.has(cid)) {
    const cached = cachedByCid.get(cid)!;
    if (cached.projectId === null && Date.now() < cached.expiresAt) return null;
    if (cached.projectId && projectExistsForLayout(uid, cached.projectId)) return cached.projectId;
    cachedByCid.delete(cid);
  }

  // Global conversations are the common case. Resolve that compact index
  // first and cache the negative project result; the previous project-first
  // order multiplied one lookup by the number of projects and repeated the
  // same work for members, state, and history.
  const globalIdx = path.join(userChatsDir(uid), '_index.json');
  for (const row of readJsonArray(globalIdx)) {
    if (row?.conversation_id !== cid) continue;
    const pid = typeof row?.project_id === 'string' ? row.project_id : '';
    if (projectExistsForLayout(uid, pid)) {
      rememberConversationProject(uid, cid, pid);
      return pid;
    }
    rememberConversationProject(uid, cid, null);
    return null;
  }
  for (const pid of listProjectIds(uid)) {
    const idx = projectChatIndexFile(uid, pid);
    for (const row of readJsonArray(idx)) {
      if (row?.conversation_id === cid) {
        rememberConversationProject(uid, cid, pid);
        return pid;
      }
    }
    if (fs.existsSync(projectChatJsonlFile(uid, pid, cid)) || fs.existsSync(projectGroupChatDir(uid, pid, cid))) {
      rememberConversationProject(uid, cid, pid);
      return pid;
    }
  }
  return null;
}

export function projectIdForConversationHint(uid: string, cid: string, projectHint?: string | null): string | null {
  if (projectHint === null) {
    if (safeId(cid)) rememberConversationProject(uid, cid, null);
    return null;
  }
  if (projectHint && projectExistsForLayout(uid, projectHint)) {
    if (safeId(cid)) rememberConversationProject(uid, cid, projectHint);
    return projectHint;
  }
  return findProjectIdForConversation(uid, cid);
}

export interface ConversationLayout {
  projectId: string | null;
  chatsDir: string;
  indexFile: string;
  messageFile: string;
  groupDir: string;
  metaFile: string;
  membersFile: string;
  stateFile: string;
  planFile: string;
  visibilityDir: string;
  visibilityFile(actorId: string): string;
  messageRelPath: string;
  indexRelPath: string;
}

export function conversationLayout(uid: string, cid: string, projectHint?: string | null): ConversationLayout {
  const pid = projectIdForConversationHint(uid, cid, projectHint);
  if (pid) {
    return {
      projectId: pid,
      chatsDir: projectChatsDir(uid, pid),
      indexFile: projectChatIndexFile(uid, pid),
      messageFile: projectChatJsonlFile(uid, pid, cid),
      groupDir: projectGroupChatDir(uid, pid, cid),
      metaFile: path.join(projectGroupChatDir(uid, pid, cid), 'meta.json'),
      membersFile: projectGroupChatMembersFile(uid, pid, cid),
      stateFile: projectGroupChatStateFile(uid, pid, cid),
      planFile: projectGroupChatPlanFile(uid, pid, cid),
      visibilityDir: projectGroupChatVisibilityDir(uid, pid, cid),
      visibilityFile: (actorId: string) => projectGroupChatVisibilityFile(uid, pid, cid, actorId),
      messageRelPath: `cloud/projects/${pid}/chats/${cid}.jsonl`,
      indexRelPath: `cloud/projects/${pid}/chats/_index.json`,
    };
  }
  const dir = userChatsDir(uid);
  const groupDir = path.join(dir, cid);
  return {
    projectId: null,
    chatsDir: dir,
    indexFile: path.join(dir, '_index.json'),
    messageFile: path.join(dir, `${cid}.jsonl`),
    groupDir,
    metaFile: path.join(groupDir, 'meta.json'),
    membersFile: path.join(groupDir, 'members.json'),
    stateFile: path.join(groupDir, 'state.json'),
    planFile: path.join(groupDir, 'plan.json'),
    visibilityDir: path.join(groupDir, 'visibility'),
    visibilityFile: (actorId: string) => path.join(groupDir, 'visibility', `${actorId}.jsonl`),
    messageRelPath: `cloud/chats/${cid}.jsonl`,
    indexRelPath: 'cloud/chats/_index.json',
  };
}

export function conversationMessageFile(uid: string, cid: string, projectHint?: string | null): string {
  return conversationLayout(uid, cid, projectHint).messageFile;
}

/** Read-only compatibility lookup for legacy bytes that arrived before the
 * v4 repair pass. Writers must use conversationMessageFile() so they never
 * extend the old top-level layout. */
export function conversationMessageReadFile(uid: string, cid: string, projectHint?: string | null): string {
  const layout = conversationLayout(uid, cid, projectHint);
  if (layout.projectId && !fs.existsSync(layout.messageFile)) {
    const legacy = path.join(userChatsDir(uid), `${cid}.jsonl`);
    if (fs.existsSync(legacy)) return legacy;
  }
  if (layout.projectId || fs.existsSync(layout.messageFile)) return layout.messageFile;
  return path.join(userChatsDir(uid), `${cid}.jsonl`);
}

export function cidFromProjectSessionId(uid: string, sessionId: string): string | null {
  if (sessionId.startsWith('gconv-')) {
    const cid = sessionId.slice('gconv-'.length);
    return safeId(cid) ? cid : null;
  }
  if (!sessionId.startsWith('gmember-')) return null;
  const rest = sessionId.slice('gmember-'.length);
  for (const cid of listProjectConversationIds(uid)) {
    if (rest === cid || rest.startsWith(`${cid}-`)) return cid;
  }
  const dash = rest.indexOf('-');
  const fallback = dash > 0 ? rest.slice(0, dash) : '';
  return safeId(fallback) ? fallback : null;
}

export function projectIdForSession(uid: string, sessionId: string): string | null {
  const cid = cidFromProjectSessionId(uid, sessionId);
  return cid ? findProjectIdForConversation(uid, cid) : null;
}

export function cloudSessionFileFor(uid: string, sessionId: string): string {
  const pid = projectIdForSession(uid, sessionId);
  return pid ? projectSessionFile(uid, pid, sessionId) : userSessionFile(uid, sessionId);
}

export function cloudSessionToolResultsDirFor(uid: string, sessionId: string): string {
  const pid = projectIdForSession(uid, sessionId);
  return pid ? projectSessionCloudToolResultsDir(uid, pid, sessionId) : sessionCloudToolResultsDir(uid, sessionId);
}

export function projectSessionRoots(uid: string, cid: string): string[] {
  const pid = findProjectIdForConversation(uid, cid);
  return pid ? [projectSessionsDir(uid, pid), userSessionsDir(uid)] : [userSessionsDir(uid)];
}

export function chatAttachmentDirForConversation(uid: string, cid: string, projectHint?: string | null): string {
  const pid = projectIdForConversationHint(uid, cid, projectHint);
  return pid ? projectChatAttachmentDir(uid, pid, cid) : chatAttachmentDir(uid, cid);
}

export function chatAttachmentRelPath(uid: string, cid: string, name: string, projectHint?: string | null): string {
  const pid = projectIdForConversationHint(uid, cid, projectHint);
  return pid
    ? `cloud/projects/${pid}/chat_attachments/${cid}/${name}`
    : `cloud/chat_attachments/${cid}/${name}`;
}

export function chatArtifactCidDirForConversation(uid: string, cid: string, projectHint?: string | null): string {
  const pid = projectIdForConversationHint(uid, cid, projectHint);
  return pid ? projectChatArtifactCidDir(uid, pid, cid) : chatArtifactCidDir(uid, cid);
}

export function artifactDirForConversation(uid: string, cid: string, artifactId: string, projectHint?: string | null): string {
  const pid = projectIdForConversationHint(uid, cid, projectHint);
  return pid ? projectArtifactDir(uid, pid, cid, artifactId) : artifactDir(uid, cid, artifactId);
}

export function chatArtifactRelPath(uid: string, cid: string, artifactId: string, rel = '', projectHint?: string | null): string {
  const pid = projectIdForConversationHint(uid, cid, projectHint);
  return pid
    ? ['cloud/projects', pid, 'chat_artifacts', cid, artifactId, rel].filter(Boolean).join('/')
    : ['cloud/chat_artifacts', cid, artifactId, rel].filter(Boolean).join('/');
}

export interface AutoTaskLocation {
  taskId: string;
  projectId: string | null;
  dir: string;
  configFile: string;
  attachmentsDir: string;
  configRelPath: string;
  attachmentsRelBase: string;
}

export function globalAutoTaskLocation(uid: string, taskId: string): AutoTaskLocation {
  return {
    taskId,
    projectId: null,
    dir: autoTaskDir(uid, taskId),
    configFile: autoTaskConfigFile(uid, taskId),
    attachmentsDir: autoTaskAttachmentsDir(uid, taskId),
    configRelPath: `cloud/auto_tasks/${taskId}/config.json`,
    attachmentsRelBase: `cloud/auto_tasks/${taskId}/attachments`,
  };
}

export function projectAutoTaskLocation(uid: string, pid: string, taskId: string): AutoTaskLocation {
  return {
    taskId,
    projectId: pid,
    dir: projectAutoTaskDir(uid, pid, taskId),
    configFile: projectAutoTaskConfigFile(uid, pid, taskId),
    attachmentsDir: projectAutoTaskAttachmentsDir(uid, pid, taskId),
    configRelPath: `cloud/projects/${pid}/auto_tasks/${taskId}/config.json`,
    attachmentsRelBase: `cloud/projects/${pid}/auto_tasks/${taskId}/attachments`,
  };
}

export function listAutoTaskLocations(uid: string): AutoTaskLocation[] {
  const out: AutoTaskLocation[] = [];
  const seen = new Set<string>();
  const scanRoot = (root: string, make: (taskId: string) => AutoTaskLocation) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const loc = make(entry.name);
      if (!fs.existsSync(loc.configFile)) continue;
      const key = entry.name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(loc);
    }
  };
  for (const pid of listProjectIds(uid)) {
    scanRoot(projectAutoTasksDir(uid, pid), (taskId) => projectAutoTaskLocation(uid, pid, taskId));
  }
  scanRoot(userAutoTasksDir(uid), (taskId) => globalAutoTaskLocation(uid, taskId));
  return out;
}

export function findAutoTaskLocation(uid: string, taskId: string): AutoTaskLocation | null {
  for (const loc of listAutoTaskLocations(uid)) {
    if (loc.taskId === taskId) return loc;
  }
  return null;
}

export function autoTaskLocationForTask(uid: string, taskId: string, projectId?: string | null): AutoTaskLocation {
  if (projectId && projectExistsForLayout(uid, projectId)) {
    return projectAutoTaskLocation(uid, projectId, taskId);
  }
  return findAutoTaskLocation(uid, taskId) || globalAutoTaskLocation(uid, taskId);
}
