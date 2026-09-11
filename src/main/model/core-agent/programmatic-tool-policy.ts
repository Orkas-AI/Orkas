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
  if (host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) {
    return true;
  }
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const bytes = parts.map(Number);
  if (bytes.some((part) => part < 0 || part > 255)) return false;
  return bytes[0] === 0
    || bytes[0] === 10
    || bytes[0] === 127
    || (bytes[0] === 169 && bytes[1] === 254)
    || (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31)
    || (bytes[0] === 192 && bytes[1] === 168)
    || (bytes[0] === 100 && bytes[1] >= 64 && bytes[1] <= 127);
}
