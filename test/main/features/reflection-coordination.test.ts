import { describe, it, expect } from 'vitest';
import { beginReflection, yieldReflectionForTask, isReflectionYield } from '../../../src/main/features/reflection-coordination';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('reflection foreground handoff', () => {
  it('cancels inference without making a task wait for the model, scoped to one account', async () => {
    const first = beginReflection('one')!;
    const other = beginReflection('two')!;
    try {
      expect(beginReflection('one')).toBeNull();
      expect(yieldReflectionForTask('one')).toBeUndefined();
      expect(isReflectionYield(first.signal.reason)).toBe(true);
      expect(other.signal.aborted).toBe(false);
      let wrote = false;
      await expect(first.runTool(async () => { wrote = true; })).rejects.toThrow('yielded');
      expect(wrote).toBe(false);
    } finally { await first.close(); await other.close(); }
  });

  it('waits for an already started file operation and rejects subsequent writes', async () => {
    const lease = beginReflection('drain')!;
    const gate = deferred();
    const started = deferred();
    const order: string[] = [];
    const write = lease.runTool(async () => { started.resolve(); await gate.promise; order.push('saved'); });
    await started.promise;
    const handoff = yieldReflectionForTask('drain')!.then(() => { order.push('task'); });
    await Promise.resolve();
    expect(order).toEqual([]);
    await expect(lease.runTool(async () => { order.push('late-write'); })).rejects.toThrow('yielded');
    gate.resolve();
    await Promise.all([write, handoff, lease.close()]);
    expect(order).toEqual(['saved', 'task']);
    const next = beginReflection('drain')!;
    expect(next).not.toBeNull();
    await next.close();
  });

  it('a rejected write releases handoff and a closed lease rejects delayed tools', async () => {
    const lease = beginReflection('failure')!;
    const gate = deferred();
    const write = lease.runTool(async () => { await gate.promise; throw new Error('disk failure'); });
    const rejected = expect(write).rejects.toThrow('disk failure');
    await Promise.resolve();
    const handoff = yieldReflectionForTask('failure');
    gate.resolve();
    await rejected;
    await handoff;
    await lease.close();
    const normal = beginReflection('closed')!;
    await normal.close();
    await expect(normal.runTool(async () => 'late')).rejects.toThrow('closed');
  });
});
