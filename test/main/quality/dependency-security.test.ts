import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

const proxyaddr = require('proxy-addr');
const { SourceMapConsumer } = require('source-map-js');
const { Address6 } = require('ip-address');
const { ipKeyGenerator } = require('express-rate-limit');
const { SocksClient } = require('socks');

describe('dependency security boundaries', () => {
  it('rejects oversized IPv6 zones without stalling the caller process', () => {
    // GHSA-rxp7-6hxx-x8q5: an unpatched parser takes tens of seconds on
    // this input. Isolate it so a regression cannot block the test worker.
    const result = spawnSync(process.execPath, ['-e', `
      const { Address6 } = require(${JSON.stringify(require.resolve('ip-address'))});
      const results = ['\\n', '\\r', '\\u2028', '\\u2029'].map(terminator => {
        const address = '%'.repeat(256 * 1024) + terminator;
        let rejected = false;
        try { new Address6(address); } catch (error) {
          if (error.name !== 'AddressError') throw error;
          rejected = true;
        }
        return { rejected, valid: Address6.isValid(address) };
      });
      process.stdout.write(JSON.stringify(results));
    `], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8', timeout: 3_000, maxBuffer: 4096,
    });
    expect(result.error?.message).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(
      Array.from({ length: 4 }, () => ({ rejected: true, valid: false })),
    );
  });

  it('preserves valid IPv6 zones and rejects malformed addresses', () => {
    const address = new Address6('fe80::1%eth0');
    expect(address.correctForm()).toBe('fe80::1');
    expect(address.zone).toBe('%eth0');
    expect(Address6.isValid('2001:db8::1')).toBe(true);
    expect(Address6.isValid('2001:db8::gg')).toBe(false);
  });

  it('keeps IPv6 subnet and IPv4-mapped rate-limit identities stable', () => {
    expect(ipKeyGenerator('2001:db8:abcd:1234::1')).toBe('2001:db8:abcd:1200::/56');
    expect(ipKeyGenerator('::ffff:192.0.2.9')).toBe('192.0.2.9');
    expect(ipKeyGenerator('192.0.2.9')).toBe('192.0.2.9');
  });

  it('preserves the SOCKS IPv6 wire address, port and payload', () => {
    const data = Buffer.from('fixture');
    const frame = SocksClient.createUDPFrame({
      remoteHost: { host: '2001:db8::1', port: 443 }, data,
    });
    const expected = Buffer.concat([
      Buffer.from('0000000420010db800000000000000000000000101bb', 'hex'), data,
    ]);
    expect(frame).toEqual(expected);
    expect(SocksClient.parseUDPFrame(expected)).toEqual({
      frameNumber: 0,
      remoteHost: { host: '2001:0db8:0000:0000:0000:0000:0000:0001', port: 443 },
      data,
    });
  });

  it.each(['203.0.113.9', '::ffff:203.0.113.9'])(
    'does not accept a forwarded identity from an untrusted peer %s', address => {
      const request = {
        socket: { remoteAddress: address },
        headers: { 'x-forwarded-for': '192.0.2.10' },
      };
      for (const ranges of [['::ffff:10.0.0.0/8'], ['::ffff:10.0.0.0/8', '::1/128']]) {
        expect(proxyaddr(request, proxyaddr.compile(ranges))).toBe(address);
      }
    },
  );

  it('preserves explicitly trusted IPv4-mapped proxy subnets', () => {
    const request = {
      socket: { remoteAddress: '::ffff:10.2.3.4' },
      headers: { 'x-forwarded-for': '192.0.2.10' },
    };
    expect(proxyaddr(request, proxyaddr.compile('::ffff:10.0.0.0/104'))).toBe('192.0.2.10');
  });

  const leaf = { version: 3, sources: ['input.js'], names: [], mappings: 'AAAA' };
  const indexed = (line: number, map: unknown = leaf) => ({
    version: 3, sections: [{ offset: { line, column: 0 }, map }],
  });

  it('rejects tiny source maps that would amplify into enormous generated output', () => {
    // Construction must reject the input before a build tool serializes it.
    // Do not actually allocate the unbounded output on an unpatched version.
    expect(() => new SourceMapConsumer(indexed(1_000_000_000))).toThrow();
    expect(() => new SourceMapConsumer(indexed(6_000_000, indexed(6_000_000)))).toThrow();
  });

  it('preserves ordinary indexed source-map locations', () => {
    const consumer = new SourceMapConsumer(indexed(2));
    const mappings: unknown[] = [];
    consumer.eachMapping((mapping: unknown) => mappings.push(mapping));
    expect(mappings).toEqual([expect.objectContaining({
      source: 'input.js', generatedLine: 3, generatedColumn: 0,
      originalLine: 1, originalColumn: 0,
    })]);
  });
});
