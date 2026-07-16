import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/renderer/modules/artifact-security.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const chatSource = fs.readFileSync(path.join(root, 'src/renderer/modules/chat-artifact.js'), 'utf8');
const savedSource = fs.readFileSync(path.join(root, 'src/renderer/modules/saved-apps.js'), 'utf8');

function loadSecurity() {
  const context: any = { URL };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'artifact-security.js' });
  return context.OrkasArtifactSecurity;
}

describe('artifact iframe security boundary', () => {
  it('loads the shared boundary before eager and lazy artifact renderers use it', () => {
    expect(indexSource.indexOf('./modules/artifact-security.js')).toBeGreaterThanOrEqual(0);
    expect(indexSource.indexOf('./modules/artifact-security.js')).toBeLessThan(
      indexSource.indexOf('./modules/chat-artifact.js'),
    );
    expect(chatSource).toContain('artifactSecurity.trustedArtifactMessage');
    expect(savedSource).toContain('artifactSecurity.trustedArtifactMessage');
  });

  it('does not grant popup or top-navigation capabilities', () => {
    const security = loadSecurity();
    expect(security.SANDBOX.split(/\s+/)).toEqual([
      'allow-scripts',
      'allow-same-origin',
      'allow-forms',
    ]);
    expect(security.SANDBOX).not.toMatch(/allow-popups|allow-top-navigation/);
  });

  it('accepts only credential-free absolute HTTP(S) external URLs', () => {
    const security = loadSecurity();
    expect(security.safeExternalHttpUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(security.safeExternalHttpUrl('http://example.com')).toBe('http://example.com/');
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,boom',
      'file:///etc/passwd',
      '//example.com/path',
      'https://user:password@example.com/',
      'https://example.com/\nattack',
    ]) {
      expect(security.safeExternalHttpUrl(value)).toBeNull();
    }
  });

  it('requires both the marker and the live iframe contentWindow identity', () => {
    const security = loadSecurity();
    const liveWindow = {};
    const frame = { contentWindow: liveWindow };
    const data = { __orkasArtifact: true, type: 'submit' };
    expect(security.trustedArtifactMessage({ source: liveWindow, data }, frame)).toBe(true);
    expect(security.trustedArtifactMessage({ source: {}, data }, frame)).toBe(false);
    expect(security.trustedArtifactMessage({ source: liveWindow, data: { type: 'submit' } }, frame)).toBe(false);
    expect(security.trustedArtifactMessage({ source: liveWindow, data: null }, frame)).toBe(false);
  });
});
