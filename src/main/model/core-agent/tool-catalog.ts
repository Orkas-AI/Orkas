/**
 * ToolCatalog — 注入式内建工具清单。
 *
 * 角色与 `skill-registry.ts` 对称：把"当前会话可用的内建工具"以 markdown 块
 * 形式注入到 system prompt，让 prompt 模板（chat_agent_setup.md 等）不必
 * 硬编码工具名字。
 *
 * 数据来源：**手写中央常量表** `TOOL_CATALOG`。不从 `AgentTool` 实例派生——
 * 工具自身的 `description` 是写给 runtime-LLM 的英文长文档，而 catalog 的
 * `summary` 是写给 setup-LLM 看的中文短句，受众不同；`group` / `permission`
 * 是人脑判断的元数据，没法从代码自动推。
 *
 * 反漂移：测试 `tool-catalog.test.ts` 断言"runner.ts 实际注入的工具 name
 * 集合 ⊆ `TOOL_CATALOG` name 集合"。漏写一条 catalog entry → 测试红。
 */

import { createLogger } from '../../logger';

const log = createLogger('tool-catalog');

export type ToolGroup =
  | 'fs'        // 文件 / 工作区
  | 'shell'     // 命令行
  | 'pdf'       // PDF 渲染
  | 'kb'        // 知识库
  | 'image'     // 图像生成
  | 'web'       // 联网
  | 'meta'      // 跨会话状态
  | 'group';    // 群聊调度（commander only）

export interface ToolCatalogEntry {
  /** 工具名，必须与 `AgentTool.name` 严格一致。 */
  name: string;
  /** 一句话描述，写给 setup-LLM 看的中文。 */
  summary: string;
  /** 用途分组，决定渲染时落入哪个小节。 */
  group: ToolGroup;
  /** 受运行时权限门控制时填入。当前唯一值是 `localExec`。 */
  permission?: 'localExec';
}

/**
 * 中央常量表。新增工具时**必须**在此追加一条；漏加由测试兜底。
 *
 * 顺序在每个 group 内部按"使用频率从高到低"手动排列，以稳定 KV cache 前缀。
 */
export const TOOL_CATALOG: ToolCatalogEntry[] = [
  // 文件 / 工作区
  { name: 'read_file',     group: 'fs', summary: '读工作区或附件里的文本/PDF/DOCX 切片，或图片（多模态）' },
  { name: 'write_file',    group: 'fs', permission: 'localExec', summary: '向工作区写文本/代码/markdown 等，自动落到 $working_dir' },
  { name: 'list_files',    group: 'fs', summary: '列工作区目录树' },
  { name: 'stat_file',     group: 'fs', summary: '触发 PDF/DOCX 抽取并返回 total_chars，read_file 之前用' },
  { name: 'search_files',  group: 'fs', summary: '按名字 / glob 在工作区+附件域里找文件' },
  { name: 'grep_files',    group: 'fs', summary: '在工作区+附件域里 grep 文本（PDF/DOCX 自动抽取后搜）' },

  // 命令行
  { name: 'bash',          group: 'shell', permission: 'localExec', summary: '在用户机器上执行 shell 命令（cwd = $working_dir）' },

  // PDF
  { name: 'markdown_to_pdf', group: 'pdf', permission: 'localExec', summary: 'markdown → PDF（CJK 友好，零外部依赖）' },
  { name: 'html_to_pdf',     group: 'pdf', permission: 'localExec', summary: 'HTML → PDF（同上）' },

  // 知识库
  { name: 'kb_search',     group: 'kb', summary: '用户知识库语义检索' },
  { name: 'kb_read',       group: 'kb', summary: '读 kb_search 命中过的 KB 文件分块原文' },

  // 图像
  { name: 'generate_image', group: 'image', permission: 'localExec', summary: '调厂商图像 API 生成图片，落到工作区' },

  // 联网（厂商原生搜索可用时框架自动优先用原生，下面两个是兜底）
  { name: 'web_search',    group: 'web', summary: '内置兜底联网搜索（厂商原生搜索可用时框架自动优先用原生）' },
  { name: 'web_fetch',     group: 'web', summary: '抓取 URL 正文，配合 web_search 使用' },

  // 跨会话状态
  { name: 'cross_session_memory', group: 'meta', summary: '跨会话 user / agent memory 读写' },
  { name: 'metacognition',        group: 'meta', summary: '元认知（COMPETENCE / LEARNING_STRATEGIES）读写，env 开关控制' },

  // 群聊调度（commander 专用，普通 agent 不会注入）
  { name: 'plan_set',    group: 'group', summary: '落档整体执行计划；首次同步在群里发公告，后续覆盖只更文件' },
  { name: 'plan_update', group: 'group', summary: '更新某一步的状态（in_progress / done / failed）' },
];

/** 渲染时各 group 的固定输出顺序与 section 标题。 */
const GROUP_ORDER: ReadonlyArray<{ group: ToolGroup; title: string }> = [
  { group: 'fs',    title: '文件 / 工作区' },
  { group: 'shell', title: '命令行' },
  { group: 'pdf',   title: 'PDF' },
  { group: 'kb',    title: '知识库' },
  { group: 'image', title: '图像' },
  { group: 'web',   title: '联网' },
  { group: 'meta',  title: '跨会话状态' },
  { group: 'group', title: '群聊调度' },
];

const CATALOG_BY_NAME: ReadonlyMap<string, ToolCatalogEntry> = new Map(
  TOOL_CATALOG.map((e) => [e.name, e]),
);

const PREAMBLE =
  '按用途分组列出当前会话可用的内建工具。**调用工具不需要任何 skill 包装**——' +
  '能直接做完的事情就直接调，别为单步任务设计 skill。skill 的真正用武之地是' +
  '多步逻辑封装、第三方 API 凭证管理、重复性高的复合流程。';

/**
 * 渲染 `## 可用工具 (tools)` 块。
 *
 * `names` 应当来自 runner.ts 实际组装出的 `allTools.map(t => t.name)`——这样
 * 受运行态条件控制的工具（memory / metacognition / plan_* / 按 uid 启用
 * 的 fileTools 等）会自动跟随实际注入情况，不会出现"清单写了但实际没注入"
 * 的漂移。
 *
 * 行为：
 * - `names` 为空 → 返回 `""`（core-agent 把空字符串视为"跳过该段"）
 * - `names` 中存在但 `TOOL_CATALOG` 里查不到 → warn 日志 + 跳过该 name，不抛
 * - 输出按 `GROUP_ORDER` 固定顺序拼装，每个 group 内按 catalog 数组里出现的
 *   原始顺序——保证同样输入产生同样输出，KV cache 友好
 */
export function getToolsSystemPromptBlock(names: string[]): string {
  if (!names.length) return '';

  const seen = new Set<string>();
  const present: ToolCatalogEntry[] = [];
  for (const name of names) {
    if (typeof name !== 'string' || !name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = CATALOG_BY_NAME.get(name);
    if (!entry) {
      log.warn(`tool "${name}" injected at runtime but missing from TOOL_CATALOG; skipping`);
      continue;
    }
    present.push(entry);
  }
  if (!present.length) return '';

  const presentSet = new Set(present.map((e) => e.name));
  const lines: string[] = ['## 可用工具 (tools)', '', PREAMBLE, ''];

  for (const { group, title } of GROUP_ORDER) {
    const groupEntries = TOOL_CATALOG.filter(
      (e) => e.group === group && presentSet.has(e.name),
    );
    if (!groupEntries.length) continue;
    lines.push(`### ${title}`);
    for (const e of groupEntries) {
      const perm = e.permission === 'localExec' ? '（受本机执行权限控制）' : '';
      lines.push(`- **${e.name}** — ${e.summary}${perm}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
