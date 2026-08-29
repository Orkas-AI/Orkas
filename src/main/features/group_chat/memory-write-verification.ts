/**
 * Host-side evidence for durable-memory success claims.
 *
 * A model may only tell the user that durable memory was written when this
 * turn produced a successful `add` or `replace` result from
 * `cross_session_memory`.
 * The bus owns that evidence because it observes the validated tool lifecycle;
 * prose, reasoning, and a read-only `list` call are not evidence of a write.
 */

const MEMORY_TOOL = 'cross_session_memory';
const MEMORY_WRITES = new Set(['add', 'replace']);

type ToolCall = {
  name: string;
  action: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Tracks successful durable-memory writes from the mapped stream events. */
export class DurableMemoryWriteEvidence {
  private readonly calls = new Map<string, ToolCall>();
  private successfulWrite = false;

  observe(value: unknown): void {
    const outer = record(value);
    if (outer?.type !== 'event') return;
    const event = record(outer.event);
    if (event?.stream !== 'tool') return;
    const data = record(event.data);
    if (!data) return;

    const id = typeof data.id === 'string' ? data.id.trim() : '';
    const phase = typeof data.phase === 'string' ? data.phase : '';
    const previous = id ? this.calls.get(id) : undefined;
    const name = typeof data.name === 'string' && data.name
      ? data.name
      : previous?.name || '';

    if ((phase === 'start' || phase === 'progress') && id) {
      const args = record(data.arguments);
      const action = typeof args?.action === 'string'
        ? args.action.trim().toLowerCase()
        : previous?.action || '';
      if (name === MEMORY_TOOL || previous?.name === MEMORY_TOOL) {
        this.calls.set(id, { name: MEMORY_TOOL, action });
      }
      return;
    }

    if (phase !== 'end') return;
    if (id) this.calls.delete(id);
    const action = previous?.action || '';
    if (name === MEMORY_TOOL
        && MEMORY_WRITES.has(action)
        && data.isError === false) {
      this.successfulWrite = true;
    }
  }

  hasSuccessfulWrite(): boolean {
    return this.successfulWrite;
  }
}

// `project profile`, `user preferences`, `项目档案`, and `项目笔记` are
// also ordinary file/artifact descriptions. Scope words alone therefore only
// qualify the unambiguous noun "memory"; profile/note/preference needs an
// explicit durable-time qualifier before a success claim can be scrubbed.
const DURABLE_MEMORY_ZH = /(?:(?:长期|持久|跨会话).{0,10}(?:记忆|笔记|偏好|档案)|(?:记忆|笔记|偏好|档案).{0,10}(?:长期|持久|跨会话)|(?:项目|共享|用户|智能体|个人).{0,10}记忆|记忆.{0,10}(?:项目|共享|用户|智能体|个人)|(?:下次|以后|未来).{0,12}(?:记得|沿用|使用))/u;
const COMPLETED_WRITE_ZH = /(?:(?:已|已经|刚刚|成功|现已|全部|都|均).{0,24}(?:记下|记住|保存|记录|写入|存入|录入|更新)|(?:记下|记住|保存|记录|写入|存入|录入|更新).{0,8}(?:了|好|完成|成功|完毕))/u;
const NEGATED_OR_NONCURRENT_ZH = /(?:(?:未|没有|并未|尚未|没能|无法|不能|不曾).{0,18}(?:记下|记住|保存|记录|写入|存入|录入|更新)|(?:会|将|准备|打算|计划|可以|需要|应该|请|尝试|待).{0,18}(?:记下|记住|保存|记录|写入|存入|录入|更新)|(?:之前|此前|上次|过去|先前|早已).{0,18}(?:记下|记住|保存|记录|写入|存入|录入|更新)|(?:不要|不应|禁止|避免).{0,18}(?:声称|说|表示))/u;

const DURABLE_MEMORY_EN = /(?:(?:long[- ]term|persistent|cross[- ]session).{0,16}(?:memory|notes?|preferences?|profile)|(?:memory|notes?|preferences?|profile).{0,16}(?:long[- ]term|persistent|cross[- ]session)|(?:project|shared|user|agent|personal).{0,16}memory|memory.{0,16}(?:project|shared|user|agent|personal)|(?:for (?:the )?future|next time))/iu;
const COMPLETED_WRITE_EN = /(?:(?:i(?:'ve| have)?|we(?:'ve| have)?|already|just|successfully|now|all|everything).{0,24}(?:saved|stored|recorded|written|added|updated|remembered)|(?:saved|stored|recorded|written|added|updated|remembered).{0,12}(?:successfully|already|now|complete|completed))/iu;
const NEGATED_OR_NONCURRENT_EN = /(?:(?:not|never|didn't|did not|haven't|have not|hasn't|has not|failed to|couldn't|could not|unable to).{0,24}(?:save|store|record|write|add|update|remember)|(?:will|would|can|could|should|plan(?:ning)? to|intend to|need to|please|try to).{0,24}(?:save|store|record|write|add|update|remember)|(?:earlier|previously|last time|in the past|before).{0,24}(?:saved|stored|recorded|written|added|updated|remembered)|(?:do not|don't|should not|must not|avoid).{0,18}(?:claim|say|state))/iu;

const DURABLE_MEMORY_JA = /(?:(?:長期|永続).{0,10}(?:メモリ|メモ|記憶)|(?:メモリ|メモ|記憶).{0,10}(?:長期|永続)|(?:プロジェクト|共有|ユーザー|エージェント).{0,10}(?:メモリ|記憶)|(?:メモリ|記憶).{0,10}(?:プロジェクト|共有|ユーザー|エージェント))/u;
const COMPLETED_WRITE_JA = /(?:保存|記録|書き込|登録|覚え).{0,8}(?:しました|済み|完了|ました|てあります)/u;
const NEGATED_OR_NONCURRENT_JA = /(?:保存|記録|書き込|登録|覚え).{0,10}(?:していません|できませんでした|しません|する予定|します)/u;

const DURABLE_MEMORY_PT = /(?:(?:memória|notas?|preferências?|perfil).{0,18}(?:persistente|longo prazo)|(?:persistente|longo prazo).{0,18}(?:memória|notas?|preferências?|perfil)|memória.{0,18}(?:projeto|compartilhad[ao]|usuário|agente)|(?:projeto|compartilhad[ao]|usuário|agente).{0,18}memória)/iu;
const COMPLETED_WRITE_PT = /(?:salvei|guardei|gravei|registrei|adicionei|atualizei|foi salv[ao]|foram salv[ao]s)/iu;
const NEGATED_OR_NONCURRENT_PT = /(?:(?:não|ainda não|falhou).{0,24}(?:salvar|guardar|gravar|registrar|adicionar|atualizar)|(?:vou|iremos|posso|podemos|devo|pretendo).{0,20}(?:salvar|guardar|gravar|registrar|adicionar|atualizar))/iu;

function proseForDetection(value: string): string {
  return value
    .replace(/`[^`]*`/gu, ' ')
    .replace(/“[^”]*”|"[^"]*"/gu, ' ')
    .replace(/[*_~#]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Narrowly identifies a completed write claim that requires tool evidence. */
export function claimsCompletedDurableMemoryWrite(value: string): boolean {
  const prose = proseForDetection(String(value || ''));
  if (!prose) return false;

  const zh = DURABLE_MEMORY_ZH.test(prose)
    && COMPLETED_WRITE_ZH.test(prose)
    && !NEGATED_OR_NONCURRENT_ZH.test(prose);
  const en = DURABLE_MEMORY_EN.test(prose)
    && COMPLETED_WRITE_EN.test(prose)
    && !NEGATED_OR_NONCURRENT_EN.test(prose);
  const ja = DURABLE_MEMORY_JA.test(prose)
    && COMPLETED_WRITE_JA.test(prose)
    && !NEGATED_OR_NONCURRENT_JA.test(prose);
  const pt = DURABLE_MEMORY_PT.test(prose)
    && COMPLETED_WRITE_PT.test(prose)
    && !NEGATED_OR_NONCURRENT_PT.test(prose);
  return zh || en || ja || pt;
}

export interface MemoryClaimScrubResult {
  text: string;
  removedClaims: number;
}

function scrubProseLine(line: string): MemoryClaimScrubResult {
  const pieces = line.match(/[^。！？.!?；;]+[。！？.!?；;]*\s*/gu) || [line];
  let removedClaims = 0;
  const kept = pieces.filter((piece) => {
    if (!claimsCompletedDurableMemoryWrite(piece)) return true;
    removedClaims += 1;
    return false;
  });
  return { text: kept.join('').trimEnd(), removedClaims };
}

/**
 * Removes only unsupported success-claim sentences. Fenced code and quoted
 * Markdown are evidence examples, not the actor's own assertions, so they are
 * deliberately left untouched.
 */
export function scrubCompletedDurableMemoryWriteClaims(value: string): MemoryClaimScrubResult {
  const lines = String(value || '').split('\n');
  const out: string[] = [];
  let inFence = false;
  let removedClaims = 0;

  for (const line of lines) {
    if (/^\s*(?:```|~~~)/u.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || /^\s*>/u.test(line)) {
      out.push(line);
      continue;
    }
    const scrubbed = scrubProseLine(line);
    removedClaims += scrubbed.removedClaims;
    if (scrubbed.text || !line.trim()) out.push(scrubbed.text);
  }

  return {
    text: out.join('\n').replace(/^\s+|\s+$/gu, ''),
    removedClaims,
  };
}
