/** Content-free ACP observations, independent of tool-result presentation.
 * One bounded snapshot per dispatch is emitted into the local process log.
 * Tool IDs stay private and bounded; missing/overflowed IDs make counts partial.
 * A progress update is not evidence that a tool completed.
 */
export class AcpDiagnostics {
  private stage = 'initialize';
  private stageAt: number;
  private last = 'none';
  private rxAt?: number;
  private outAt?: number;
  private errAt?: number;
  private initAck = false;
  private rpcCode: number | null = null;
  private rpcAt = 'none';
  private errorData = false;
  private stop = 'none';
  private messages = 0;
  private invalid = 0;
  private pending = new Map<string, number>();
  private trackingLost = false;
  private permissions = 0;

  constructor(private readonly now = Date.now) { this.stageAt = now(); }

  sent(method: string): void {
    const stage = ({ initialize: 'initialize', 'session/new': 'session_new',
      'session/resume': 'session_resume', 'session/set_model': 'model',
      'session/prompt': 'prompt' } as Record<string, string>)[method];
    if (stage) { this.stage = stage; this.stageAt = this.now(); }
  }

  bytes(stream: 'stdout' | 'stderr'): void {
    if (stream === 'stdout') this.outAt = this.now();
    else this.errAt = this.now();
  }

  malformed(): void { this.invalid += 1; }
  permissionStarted(): void { this.permissions += 1; }
  permissionEnded(): void { this.permissions = Math.max(0, this.permissions - 1); }

  received(env: any): void {
    if (!env || typeof env !== 'object' || Array.isArray(env)) { this.malformed(); return; }
    this.rxAt = this.now();
    this.messages += 1;
    this.last = 'other';
    if (env.method === 'session/request_permission') this.last = 'permission';
    else if (env.method === 'session/update') {
      const upd = env.params?.update;
      const kind = upd?.sessionUpdate || upd?.kind;
      if (kind === 'agent_message_chunk') this.last = 'text';
      else if (kind === 'agent_thought_chunk') this.last = 'thought';
      else if (kind === 'usage_update') this.last = 'usage';
      else if (kind === 'available_commands_update') this.last = 'commands';
      else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const status = upd.status;
        const terminal = status === 'completed' || status === 'failed';
        this.last = terminal ? 'tool_end' : 'tool_progress';
        const id = upd.toolCallId || upd.tool?.id || upd.tool?.callId;
        if (typeof id !== 'string' || !id || id.length > 256) this.trackingLost = true;
        else if (terminal) this.pending.delete(id);
        else if (!this.pending.has(id)) {
          if (this.pending.size < 64) this.pending.set(id, this.rxAt);
          else this.trackingLost = true;
        }
      }
    } else if (env.id !== undefined) {
      const id = Number(env.id);
      if ([1, 2, 3, 100].includes(id)) {
        this.last = ({ 1: 'init_result', 2: 'session_result', 3: 'model_result', 100: 'prompt_result' })[id]!;
        if (id === 1 && !env.error) this.initAck = true;
        if (env.error) {
          this.rpcAt = this.last;
          const code = env.error.code;
          this.rpcCode = typeof code === 'number' && Number.isSafeInteger(code)
            && Math.abs(code) <= 2147483648 ? code : null;
          this.errorData = env.error.data !== undefined;
        }
        if (id === 100) {
          const reason = env.result?.stopReason;
          this.stop = env.error ? 'rpc_error' : reason == null ? 'unspecified'
            : ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(reason) ? reason : 'other';
        }
      }
    }
  }

  snapshot(status: 'completed' | 'failed' | 'cancelled' | 'timeout', end: 'protocol' | 'close' | 'spawn_error', processState: 'open' | 'exit' | 'close', exitCode: number | null) {
    const now = this.now();
    const age = (at: number | undefined) => at === undefined ? null : Math.max(0, now - at);
    return {
      v: 1, stage: this.stage, stageMs: age(this.stageAt), status, end,
      last: this.last, rxAgeMs: age(this.rxAt), outAgeMs: age(this.outAt), errAgeMs: age(this.errAt),
      messages: this.messages, invalid: this.invalid, initAck: this.initAck,
      pending: this.pending.size,
      oldestMs: this.pending.size ? age(this.pending.values().next().value) : null,
      trackingLost: this.trackingLost, permissions: this.permissions,
      rpcCode: this.rpcCode, rpcAt: this.rpcAt, errorData: this.errorData, stop: this.stop,
      process: processState, exitCode,
    };
  }
}
