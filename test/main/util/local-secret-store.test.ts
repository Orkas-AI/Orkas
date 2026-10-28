import { describe, expect, it } from 'vitest';
import * as vault from '../../../src/main/util/crypto-vault';
import {
  decryptLocalSecret, decryptLocalSecretWithMeta, encryptLocalSecret,
  isEncryptedSecret, shouldRewriteLocalSecret,
} from '../../../src/main/util/local-secret-store';

const context = { namespace: 'fixture', ownerId: 'fixture-user', recordId: 'fixture-record' };

describe('local secret facade and compatible legacy reads', () => {
  it('uses the local vault and keeps owner and record context authoritative', () => {
    const payload = encryptLocalSecret(context, 'synthetic-secret');
    expect(vault.isEncryptedPayload(payload)).toBe(true);
    expect(isEncryptedSecret(payload)).toBe(true);
    expect(decryptLocalSecretWithMeta(context, payload)).toEqual({ plaintext: 'synthetic-secret', kind: 'context' });
    expect(decryptLocalSecret(context, payload)).toBe('synthetic-secret');
    expect(shouldRewriteLocalSecret('context')).toBe(false);
    for (const changed of [{ namespace: 'other' }, { ownerId: 'other' }, { recordId: 'other' }]) {
      expect(() => decryptLocalSecret({ ...context, ...changed }, payload, { legacySeeds: ['fixture-user'] })).toThrow();
    }
  });

  it('reads context and explicitly selected legacy vaults without accepting plaintext or a wrong seed', () => {
    const seed = `${context.namespace}\0${context.ownerId}\0${context.recordId}`;
    const current = vault.encrypt(seed, 'context-fixture');
    expect(decryptLocalSecretWithMeta(context, current)).toEqual({ plaintext: 'context-fixture', kind: 'context' });
    expect(shouldRewriteLocalSecret('context')).toBe(false);
    const legacy = vault.encrypt('legacy-fixture', 'legacy-secret');
    expect(isEncryptedSecret(legacy)).toBe(true);
    expect(() => decryptLocalSecret(context, legacy)).toThrow();
    expect(decryptLocalSecretWithMeta(context, legacy, { legacySeeds: ['', 'wrong', 'legacy-fixture', 'legacy-fixture'] }))
      .toEqual({ plaintext: 'legacy-secret', kind: 'legacy' });
    expect(shouldRewriteLocalSecret('legacy')).toBe(true);
    for (const payload of ['plaintext-secret', 'ORKLSEC1:corrupt', vault.encrypt('wrong', 'fixture')]) {
      expect(() => decryptLocalSecret(context, payload)).toThrow();
    }
    expect(isEncryptedSecret(null)).toBe(false); expect(isEncryptedSecret('plaintext-secret')).toBe(false);
    // A recognized private envelope must fail closed without its private backend.
    expect(isEncryptedSecret('ORKLSEC1:corrupt')).toBe(true);
    expect(() => decryptLocalSecret(context, 'ORKLSEC1:corrupt')).toThrow(/hosted backend unavailable/);
  });

  it('rejects missing context before attempting any secret operation', () => {
    for (const key of ['namespace', 'ownerId', 'recordId']) {
      const invalid = { ...context, [key]: '' };
      expect(() => encryptLocalSecret(invalid, 'fixture')).toThrow(/missing context/);
      expect(() => decryptLocalSecret(invalid, 'fixture')).toThrow(/missing context/);
    }
  });
});
