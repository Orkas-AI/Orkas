import { isIP } from 'node:net';

import type {
  ProgrammaticToolAuthorization,
  ProgrammaticToolPolicy,
  ToolContext,
} from '#core-agent';

import { resolveVisibleConnectors } from '../../features/connectors/tools-adapter';
import { getToolCatalogEntry } from './tool-catalog';

export interface ProgrammaticToolPolicyOptions {
  userId?: string;
}

const ALLOW: ProgrammaticToolAuthorization = Object.freeze({ allowed: true });

/**
 * Build the Host-owned policy used by run_program.
 *
 * The canonical eligibility list lives on TOOL_CATALOG entries. This layer
 * evaluates only the entries that need call-specific checks. The target tool
 * still executes through AgentRunner afterward, so its normal validation,
 * workspace boundary, cancellation, and permission checks remain authoritative.
 */
export function createProgrammaticToolPolicy(
  opts: ProgrammaticToolPolicyOptions = {},
): ProgrammaticToolPolicy {
  return {
    isEligible(name) {
      return !!getToolCatalogEntry(name)?.programmatic;
    },
    async authorize(name, input, ctx) {
      const access = getToolCatalogEntry(name)?.programmatic;
      if (!access) return deny(
        'E_PROGRAM_CALLER_NOT_ALLOWED',
        `${name} is available only as a direct tool call.`,
      );
      if (access.mode === 'allow') return ALLOW;

      switch (access.policy) {
        case 'connector-read':
          return authorizeConnectorRead(opts.userId, input);
        case 'network-read':
          return authorizeNetworkRead(name, input);
        case 'workspace-read':
          return authorizeWorkspaceRead(input, ctx);
        case 'catalog-read':
          return authorizeCatalogRead(input);
      }
    },
  };
}

async function authorizeConnectorRead(
  userId: string | undefined,
  input: Record<string, unknown>,
): Promise<ProgrammaticToolAuthorization> {
  if (!userId) {
    return deny('E_PROGRAM_CONNECTOR_SCOPE', 'Connector scope is unavailable for this run.');
  }
  const connectorId = stringArg(input.connector_id);
  const toolName = stringArg(input.tool_name);
  if (!connectorId || !toolName) {
    return deny(
      'E_PROGRAM_BAD_TOOL_INPUT',
      'connector_id and tool_name are required before a connector action can be authorized.',
    );
  }

  const visible = await resolveVisibleConnectors(userId);
  const match = visible.find(({ instance }) => instance.id === connectorId);
  if (!match) {
    return deny(
      'E_PROGRAM_CONNECTOR_NOT_VISIBLE',
      `Connector "${connectorId}" is not visible to this run.`,
    );
  }
  if (match.instance.origin === 'custom' || connectorId.startsWith('custom-')) {
    return deny(
      'E_PROGRAM_CONNECTOR_UNTRUSTED',
      'Custom connector actions require direct tool calls.',
    );
  }

  const action = match.tools.find((tool) => tool.name === toolName);
  if (!action) {
    return deny(
      'E_PROGRAM_CONNECTOR_ACTION_NOT_VISIBLE',
      `Connector action "${toolName}" is not visible to this run.`,
    );
  }
  if (action.annotations?.readOnlyHint !== true || action.annotations.destructiveHint === true) {
    return deny(
      'E_PROGRAM_CONNECTOR_NOT_READ_ONLY',
      'This connector action has not been explicitly declared non-destructive and read-only; use a direct tool call.',
    );
  }
  return ALLOW;
}

function authorizeNetworkRead(
  name: string,
  input: Record<string, unknown>,
): ProgrammaticToolAuthorization {
  if (name !== 'web_fetch') return ALLOW;
  const rawUrl = stringArg(input.url);
  if (!rawUrl) return deny('E_PROGRAM_BAD_TOOL_INPUT', 'web_fetch requires a URL.');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return deny('E_PROGRAM_BAD_TOOL_INPUT', 'web_fetch requires a valid absolute URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return deny(
      'E_PROGRAM_NETWORK_SCOPE',
      'Programmatic web_fetch permits only credential-free HTTP(S) URLs.',
    );
  }
  if (isLocalOrPrivateHostname(url.hostname)) {
    return deny(
      'E_PROGRAM_NETWORK_SCOPE',
      'Programmatic web_fetch cannot target a local or private-network address.',
    );
  }
  return ALLOW;
}

function authorizeWorkspaceRead(
  input: Record<string, unknown>,
  ctx: ToolContext,
): ProgrammaticToolAuthorization {
  if (!ctx.workingDir) {
    return deny(
      'E_PROGRAM_WORKSPACE_SCOPE',
      'The current run has no workspace scope for programmatic document inspection.',
    );
  }
  // These catalog entries are read/review operations, but guard against a
  // future schema adding an explicit destination without updating the policy.
  for (const key of ['output_path', 'destination', 'write_path']) {
    if (key in input) {
      return deny(
        'E_PROGRAM_WORKSPACE_WRITE_NOT_ALLOWED',
        `Programmatic read tools cannot set ${key}.`,
      );
    }
  }
  return ALLOW;
}

function authorizeCatalogRead(input: Record<string, unknown>): ProgrammaticToolAuthorization {
  for (const key of ['install', 'enable', 'delete', 'write']) {
    if (input[key] === true) {
      return deny(
        'E_PROGRAM_CATALOG_MUTATION_NOT_ALLOWED',
        `Programmatic catalog search cannot request ${key}.`,
      );
    }
  }
  return ALLOW;
}

function deny(code: string, reason: string): ProgrammaticToolAuthorization {
  return { allowed: false, code, reason, directCallAllowed: true };
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isLocalOrPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::' || host === '::1') return true;

  const version = isIP(host);
  if (version === 6) {
    const words = parseIpv6Words(host);
    if (!words) return true;
    const [w0, , , , , , w6, w7] = words;
    if (words.every((w) => w === 0)) return true;
    if (words.slice(0, 7).every((w) => w === 0) && w7 === 1) return true;
    if ((w0 & 0xfe00) === 0xfc00 || (w0 & 0xffc0) === 0xfe80 || (w0 & 0xff00) === 0xff00) return true;

    const embedded = embeddedIpv4Octets(words);
    if (!embedded) return false;
    return isLocalOrPrivateIpv4Prefix(embedded[0], embedded[1]);
  }
  if (version !== 4) return false;
  const [first, second] = host.split('.').map(Number);
  return isLocalOrPrivateIpv4Prefix(first, second);
}

function parseIpv6Words(host: string): number[] | null {
  let normalized = host;
  const lastColon = normalized.lastIndexOf(':');
  if (lastColon >= 0 && normalized.includes('.', lastColon)) {
    const ipv4Part = normalized.slice(lastColon + 1);
    if (isIP(ipv4Part) !== 4) return null;
    const [a, b, c, d] = ipv4Part.split('.').map(Number);
    normalized = `${normalized.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const words = [...head, ...Array<string>(missing).fill('0'), ...tail].map((part) => (
    /^[0-9a-f]{1,4}$/i.test(part) ? Number.parseInt(part, 16) : Number.NaN
  ));
  return words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

function embeddedIpv4Octets(words: readonly number[]): [number, number, number, number] | null {
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;
  const octets = (hi: number, lo: number): [number, number, number, number] => [
    (hi >>> 8) & 0xff,
    hi & 0xff,
    (lo >>> 8) & 0xff,
    lo & 0xff,
  ];
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
    return octets(w6, w7);
  }
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0xffff && w5 === 0) {
    return octets(w6, w7);
  }
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && (w6 !== 0 || w7 > 1)) {
    return octets(w6, w7);
  }
  if (w0 === 0x0064 && w1 === 0xff9b && ((w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) || w2 === 1)) {
    return octets(w6, w7);
  }
  if (w0 === 0x2002) {
    return octets(w1, w2);
  }
  if (w0 === 0x2001 && w1 === 0x0000) {
    return octets(w6 ^ 0xffff, w7 ^ 0xffff);
  }
  return null;
}

function isLocalOrPrivateIpv4Prefix(first: number, second: number): boolean {
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127)
    || first >= 224;
}
