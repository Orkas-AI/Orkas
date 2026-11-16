import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
let productionRequestStatePath: typeof import('../../../src/main/features/video_production_budget').productionRequestStatePath;
let productionRequestHold: typeof import('../../../src/main/features/video_production_budget').productionRequestHold;
let reserveProductionRequest: typeof import('../../../src/main/features/video_production_budget').reserveProductionRequest;
let settleProductionRequest: typeof import('../../../src/main/features/video_production_budget').settleProductionRequest;
let releaseProductionRequest: typeof import('../../../src/main/features/video_production_budget').releaseProductionRequest;
let hasPendingProductionRequest: typeof import('../../../src/main/features/video_production_budget').hasPendingProductionRequest;
let appConversationRoot: typeof import('../../../src/main/paths').appConversationRoot;
let root: string, previous: string | undefined;
const key = { userId: 'u_video_requests', scope: 'conversation' };
beforeEach(async () => {  
root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'video-request-record-'))); previous = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = root; vi.resetModules();
  ({ productionRequestStatePath, productionRequestHold, reserveProductionRequest, settleProductionRequest, releaseProductionRequest, hasPendingProductionRequest } = await import('../../../src/main/features/video_production_budget'));
  ({ appConversationRoot } = await import('../../../src/main/paths'));
});
afterEach(async () => { if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previous; await fs.rm(root, { recursive: true, force: true }); });
describe('local generation request records', () => {
  it('atomically records one pending identity and distinguishes its completed output', async () => {
    const request = { ...key, fingerprint: 'a'.repeat(64), kind: 'video' as const, videoRoute: 'chosen' };
    const results = await Promise.all([reserveProductionRequest(request), reserveProductionRequest(request)]);
    expect(results.map(result => result.status).sort()).toEqual(['already_reserved', 'reserved']);
    expect(await productionRequestHold(request)).toMatchObject({ state: 'reserved', video_route: 'chosen' });
    await settleProductionRequest({ ...request, output: path.join(root, 'result.mp4') });
    expect(await reserveProductionRequest(request)).toMatchObject({ status: 'already_settled' });
    expect(await productionRequestHold(request)).toMatchObject({ state: 'settled', output: path.join(root, 'result.mp4'), video_route: 'chosen' });
  });
  it('releases a definite pre-dispatch failure while retaining completed records', async () => {
    const request = { ...key, fingerprint: 'b'.repeat(64), kind: 'image' as const };
    await reserveProductionRequest(request); await releaseProductionRequest(request); expect(await productionRequestHold(request)).toBeNull();
    await reserveProductionRequest(request); await settleProductionRequest(request); await releaseProductionRequest(request); expect(await productionRequestHold(request)).toMatchObject({ state: 'settled' });
  });
  it('does not reinterpret a still pending request as a completed or free retry', async () => {
    const request = { ...key, fingerprint: 'c'.repeat(64), kind: 'video' as const }; await reserveProductionRequest(request);
    expect(await reserveProductionRequest({ ...request, sendAgain: true })).toMatchObject({ status: 'already_reserved' });
    expect(await productionRequestHold(request)).toMatchObject({ state: 'reserved' });
  });
  it('retains an earlier completed record when the caller explicitly starts a replacement', async () => {
    const request = { ...key, fingerprint: 'd'.repeat(64), kind: 'video' as const }; await reserveProductionRequest(request); await settleProductionRequest({ ...request, output: 'retained-first.mp4' });
    expect(await reserveProductionRequest({ ...request, sendAgain: true })).toMatchObject({ status: 'reserved' });
    const book = JSON.parse(await fs.readFile(productionRequestStatePath(key), 'utf8')); expect(Object.values(book.entries)).toContainEqual(expect.objectContaining({ state: 'settled', output: 'retained-first.mp4' }));
  });
  it('isolates local users and conversations without recording account balances or prompts', async () => {
    const request = { ...key, fingerprint: 'e'.repeat(64), kind: 'video' as const }; await reserveProductionRequest(request);
    expect(await productionRequestHold({ ...request, userId: 'other_local_user' })).toBeNull(); expect(await productionRequestHold({ ...request, scope: 'other_conversation' })).toBeNull();
    const raw = await fs.readFile(productionRequestStatePath(key), 'utf8'); expect(raw).not.toMatch(/credits|price_confirmation|session_id|apiKey|prompt/);
  });
  it('stores private application records inside the owning session so release removes them', async () => {
    const scope = `app_${'a'.repeat(64)}_retain_${'b'.repeat(32)}`; const request = { ...key, scope, fingerprint: 'f'.repeat(64), kind: 'image' as const };
    const ownerRoot = appConversationRoot(key.userId, scope)!; const file = productionRequestStatePath(request); expect(path.relative(ownerRoot, file)).not.toMatch(/^\.\./);
    await reserveProductionRequest(request); await fs.rm(ownerRoot, { recursive: true, force: true }); expect(await productionRequestHold(request)).toBeNull();
  });
  it.each(['{broken', '{"version":1,"entries":null}', '{"version":99,"entries":{}}'])('preserves unreadable request history and refuses a new reservation: %s', async raw => {
    const file = productionRequestStatePath(key); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, raw);
    await expect(reserveProductionRequest({ ...key, fingerprint: '1'.repeat(64), kind: 'video' })).rejects.toThrow(); expect(await fs.readFile(file, 'utf8')).toBe(raw);
  });
  it('refuses to settle an unknown identity instead of inventing a successful request', async () => {
    await expect(settleProductionRequest({ ...key, fingerprint: '2'.repeat(64), output: 'not-produced.mp4' })).rejects.toThrow();
  });
});

describe('pending production shots across canvas turns', () => {
  const shot = () => ({ ...key, productionDirAbs: path.join(root, 'production'), shot: 'hero', kind: 'video' as const });
  it('keeps the same unresolved shot visible across a new canvas turn without storing its prompt', async () => {
    const input = shot(); await reserveProductionRequest({ ...key, fingerprint: '3'.repeat(64), kind: 'video', production: { dir: input.productionDirAbs, shot: input.shot } });
    expect(await hasPendingProductionRequest(input)).toBe(true);
    for (const changed of [{ scope: 'another-chat' }, { userId: 'another-user' }, { productionDirAbs: path.join(root, 'elsewhere') }, { shot: 'next-shot' }, { kind: 'image' as const }]) expect(await hasPendingProductionRequest({ ...input, ...changed })).toBe(false);
    expect(await fs.readFile(productionRequestStatePath(key), 'utf8')).not.toMatch(/prompt|credits|price_confirmation|apiKey/);
  });
  it('stops marking a shot pending after a definite failure or a completed output', async () => {
    const input = shot(), request = { ...key, fingerprint: '4'.repeat(64), kind: 'video' as const, production: { dir: input.productionDirAbs, shot: input.shot } };
    await reserveProductionRequest(request); await releaseProductionRequest(request); expect(await hasPendingProductionRequest(input)).toBe(false);
    await reserveProductionRequest(request); await settleProductionRequest({ ...request, output: path.join(root, 'result.mp4') }); expect(await hasPendingProductionRequest(input)).toBe(false);
  });
  it('retains legacy records that have no production metadata without inventing a shot', async () => {
    await reserveProductionRequest({ ...key, fingerprint: '5'.repeat(64), kind: 'video' }); expect(await hasPendingProductionRequest(shot())).toBe(false);
    expect(await productionRequestHold({ ...key, fingerprint: '5'.repeat(64) })).toMatchObject({ state: 'reserved' });
  });
  it.each([null, [], { dir: 4, shot: 'hero' }, { dir: 'x', shot: null }].map(production => ({ production })))('refuses damaged production metadata without overwriting it: %j', async ({ production }) => {
    const file = productionRequestStatePath(key); await fs.mkdir(path.dirname(file), { recursive: true }); const raw = JSON.stringify({ version: 1, scope: key.scope, entries: { ['6'.repeat(64)]: { kind: 'video', state: 'reserved', at: new Date().toISOString(), production } } }); await fs.writeFile(file, raw);
    await expect(hasPendingProductionRequest(shot())).rejects.toThrow(); expect(await fs.readFile(file, 'utf8')).toBe(raw);
  });
});


it('retains pending and completed identities across a module restart without reserving them twice', async () => {
  const request = { ...key, fingerprint: '7'.repeat(64), kind: 'video' as const, videoRoute: 'selected-service' };
  await reserveProductionRequest(request);
  vi.resetModules();
  let fresh = await import('../../../src/main/features/video_production_budget');
  expect(await fresh.reserveProductionRequest(request)).toEqual({ status: 'already_reserved' });
  await fresh.settleProductionRequest({ ...request, output: 'completed.mp4' });
  vi.resetModules();
  fresh = await import('../../../src/main/features/video_production_budget');
  expect(await fresh.reserveProductionRequest(request)).toEqual({ status: 'already_settled' });
  expect(await fresh.productionRequestHold(request)).toMatchObject({ state: 'settled', output: 'completed.mp4', video_route: 'selected-service' });
});
