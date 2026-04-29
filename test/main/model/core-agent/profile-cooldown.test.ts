import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  markCooldown,
  isCooledDown,
  getCooldown,
  clearCooldown,
  listCooldowns,
  _clearAll,
  DEFAULT_COOLDOWN_MS,
  NETWORK_COOLDOWN_MS,
} from '../../../../src/main/model/core-agent/profile-cooldown';

describe('profile-cooldown', () => {
  beforeEach(() => {
    _clearAll();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _clearAll();
  });

  it('markCooldown + isCooledDown 基本往返', () => {
    markCooldown('openai:work', 'auth', 'invalid api key');
    expect(isCooledDown('openai:work')).toBe(true);
    expect(isCooledDown('openai:other')).toBe(false);
  });

  it('cooldown 过期后 isCooledDown 返 false 并自动清理', () => {
    markCooldown('p1', 'auth', 'x', 1000);
    expect(isCooledDown('p1')).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(isCooledDown('p1')).toBe(false);
    // 二次查询确认已从 state 里清掉
    expect(getCooldown('p1')).toBeUndefined();
  });

  it('clearCooldown 立即清除（模拟用户手动编辑 key）', () => {
    markCooldown('p1', 'auth', 'x');
    clearCooldown('p1');
    expect(isCooledDown('p1')).toBe(false);
  });

  it('重复 markCooldown 覆盖旧记录（新窗口从 now 开始）', () => {
    markCooldown('p1', 'rate_limit', 'old', 1000);
    vi.advanceTimersByTime(500);
    markCooldown('p1', 'auth', 'new', 5000);
    vi.advanceTimersByTime(1000);
    expect(isCooledDown('p1')).toBe(true);
    expect(getCooldown('p1')?.kind).toBe('auth');
    expect(getCooldown('p1')?.reason).toBe('new');
  });

  it('getCooldown 返回 reason + kind + cooledUntil', () => {
    markCooldown('p1', 'balance', '余额不足', 3000);
    const entry = getCooldown('p1');
    expect(entry?.kind).toBe('balance');
    expect(entry?.reason).toBe('余额不足');
    expect(entry?.cooledUntil).toBeGreaterThan(Date.now());
  });

  it('listCooldowns 按 cooledUntil 升序，跳过已过期', () => {
    markCooldown('p1', 'auth', 'a', 5000);
    markCooldown('p2', 'rate_limit', 'b', 1000);
    markCooldown('p3', 'balance', 'c', 3000);
    vi.advanceTimersByTime(1500); // p2 过期
    const list = listCooldowns();
    expect(list.map((c) => c.profileId)).toEqual(['p3', 'p1']);
  });

  it('空 profileId 静默忽略（不崩）', () => {
    expect(() => markCooldown('', 'auth', 'x')).not.toThrow();
    expect(isCooledDown('')).toBe(false);
    expect(() => clearCooldown('')).not.toThrow();
  });

  it('DEFAULT_COOLDOWN_MS 是 10 分钟（实施口径，改了这条测试要一起改 plan）', () => {
    expect(DEFAULT_COOLDOWN_MS).toBe(10 * 60 * 1000);
  });

  it('network kind 默认走 NETWORK_COOLDOWN_MS（30 秒）而非 10 分钟', () => {
    markCooldown('p1', 'network', 'ECONNRESET');
    const entry = getCooldown('p1');
    expect(entry?.cooledUntil).toBeGreaterThan(Date.now());
    // 30 秒 + 1 ms 之后应该已经过期；如果错按 DEFAULT_COOLDOWN_MS 那 30 秒是远不够的
    vi.advanceTimersByTime(NETWORK_COOLDOWN_MS + 1);
    expect(isCooledDown('p1')).toBe(false);
  });

  it('NETWORK_COOLDOWN_MS 是 30 秒（实施口径）', () => {
    expect(NETWORK_COOLDOWN_MS).toBe(30 * 1000);
  });
});
