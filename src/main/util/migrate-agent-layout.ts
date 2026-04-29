/**
 * 一次性数据迁移:把每个 agent 的 spec(原 `<uid>/cloud/agents/<aid>.json`)+
 * 元认知输出(原 `<uid>/cloud/meta/<aid>/{COMPETENCE,LEARNING_STRATEGIES}.md`)
 * 搬到统一的 agent 目录 `<uid>/cloud/agents/<aid>/`:
 *
 *   <uid>/cloud/agents/<aid>/
 *   ├── agent.json                           ← 来自 <uid>/cloud/agents/<aid>.json
 *   └── meta/
 *       ├── COMPETENCE.md                    ← 来自 <uid>/cloud/meta/<aid>/COMPETENCE.md
 *       └── LEARNING_STRATEGIES.md           ← 同上
 *
 * 最后删空的顶层 `meta/` 目录。
 *
 * 详见 docs/plans/agent-as-directory.md。
 *
 * 设计要点:
 *   - 启动期 idempotent:`<uid>/local/.migrations` 盖章 `agent-as-directory-v1` 防重跑
 *   - 旧 `<aid>.json` 与新 `<aid>/agent.json` 共存时优先认新格式(说明上一次跑了一半)
 *   - 找不到对应 agent 的 meta 子目录会 log.warn 但不阻塞迁移
 *   - 迁移失败任意一项不会卡住别的;盖章只在整个流程跑完后落盘
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userAgentsDir, userCloudRoot, userLocalConfigDir } from '../paths';
import { createLogger } from '../logger';

const log = createLogger('migrate');

const MIGRATION_TAG = 'agent-as-directory-v1';

function migrationsFile(uid: string): string {
  // userLocalConfigDir = <uid>/local/config;上一层就是 <uid>/local/。
  // 与 migrate-session-ids 共用同一个 .migrations 文件,多 tag 一行一条。
  return path.join(path.dirname(userLocalConfigDir(uid)), '.migrations');
}

function alreadyApplied(uid: string): boolean {
  const f = migrationsFile(uid);
  if (!fs.existsSync(f)) return false;
  try {
    const content = fs.readFileSync(f, 'utf8');
    return content.split('\n').some((line) => line.trim() === MIGRATION_TAG);
  } catch {
    return false;
  }
}

function stamp(uid: string): void {
  const f = migrationsFile(uid);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, MIGRATION_TAG + '\n', 'utf8');
}

interface MigrationStats {
  agentsConverted: number;
  metaMoved: number;
  warnings: number;
}

/**
 * Migrate one user's agent layout in place. Idempotent — already-stamped uids
 * return zero stats without touching disk. Safe to call on every boot.
 */
export function migrateAgentLayout(uid: string): MigrationStats {
  const stats: MigrationStats = { agentsConverted: 0, metaMoved: 0, warnings: 0 };
  if (alreadyApplied(uid)) return stats;

  const agentsRoot = userAgentsDir(uid);
  const oldMetaRoot = path.join(userCloudRoot(uid), 'meta');

  // 1. 扫 agents/<aid>.json,搬到 agents/<aid>/agent.json
  if (fs.existsSync(agentsRoot)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
    } catch (err) {
      log.warn(`readdir failed ${agentsRoot}: ${(err as Error).message}`);
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json') || e.name.startsWith('.')) continue;
      const aid = e.name.replace(/\.json$/, '');
      const oldFile = path.join(agentsRoot, e.name);
      const newDir = path.join(agentsRoot, aid);
      const newFile = path.join(newDir, 'agent.json');
      if (fs.existsSync(newFile)) {
        // 上一次跑了一半 / 用户手动建过新格式 → 认新格式,删旧 flat file
        try {
          fs.unlinkSync(oldFile);
          log.info(`migrate: dropped redundant flat ${oldFile} (new agent.json already exists)`);
        } catch (err) {
          log.warn(`migrate: unlink redundant ${oldFile} failed: ${(err as Error).message}`);
          stats.warnings += 1;
        }
        continue;
      }
      try {
        fs.mkdirSync(newDir, { recursive: true });
        fs.renameSync(oldFile, newFile);
        stats.agentsConverted += 1;
      } catch (err) {
        log.warn(`migrate: agent ${aid} flat→dir failed: ${(err as Error).message}`);
        stats.warnings += 1;
      }
    }
  }

  // 2. 扫旧的 cloud/meta/<aid>/,搬到 cloud/agents/<aid>/meta/
  if (fs.existsSync(oldMetaRoot)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(oldMetaRoot, { withFileTypes: true });
    } catch (err) {
      log.warn(`readdir failed ${oldMetaRoot}: ${(err as Error).message}`);
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const aid = e.name;
      const srcDir = path.join(oldMetaRoot, aid);
      const targetDir = path.join(agentsRoot, aid, 'meta');
      try {
        fs.mkdirSync(targetDir, { recursive: true });
        for (const f of fs.readdirSync(srcDir)) {
          const src = path.join(srcDir, f);
          const dst = path.join(targetDir, f);
          if (fs.existsSync(dst)) {
            log.warn(`migrate: meta target exists, skipping ${dst}`);
            stats.warnings += 1;
            continue;
          }
          fs.renameSync(src, dst);
          stats.metaMoved += 1;
        }
        // src 空了 → 删 src 目录
        try { fs.rmdirSync(srcDir); }
        catch { /* 残留留着,下一次再清 */ }
      } catch (err) {
        log.warn(`migrate: meta agent ${aid} failed: ${(err as Error).message}`);
        stats.warnings += 1;
      }
    }
    // 顶层 meta/ 整体删除(rmdirSync 只在空时成功,有残留会保留;无碍)
    try { fs.rmdirSync(oldMetaRoot); }
    catch { /* keep */ }
  }

  stamp(uid);
  if (stats.agentsConverted || stats.metaMoved || stats.warnings) {
    log.info(
      `agent-layout migration done uid=${uid} agents=${stats.agentsConverted} meta=${stats.metaMoved} warnings=${stats.warnings}`,
    );
  }
  return stats;
}
