import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const auto = require('../../src/renderer/modules/auto.js') as {
  _autoDisplayDeviceName: (name: string) => string;
};

describe('auto device display name', () => {
  it('strips the mDNS .local suffix from hostnames', () => {
    expect(auto._autoDisplayDeviceName('claw2deMac-mini.local')).toBe('claw2deMac-mini');
    expect(auto._autoDisplayDeviceName('Desk.LOCAL.')).toBe('Desk');
  });

  it('leaves non-mDNS identifiers unchanged', () => {
    expect(auto._autoDisplayDeviceName('aa:bb:cc:dd:ee:ff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(auto._autoDisplayDeviceName('workstation.localdomain')).toBe('workstation.localdomain');
  });
});
