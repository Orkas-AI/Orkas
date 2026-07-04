import * as os from 'node:os';
import * as path from 'node:path';

import { clientConfig } from './client_config';

export type LocalAccessRiskCategory = 'network_egress' | 'destructive' | 'priv_esc' | 'sensitive_path';

export interface SensitiveCommandPattern {
  category: LocalAccessRiskCategory;
  pattern: string;
}

export interface LocalAccessSensitivePolicy {
  enabled_categories: LocalAccessRiskCategory[];
  sensitive_path_patterns: string[];
  sensitive_write_path_patterns: string[];
  sensitive_command_patterns: SensitiveCommandPattern[];
}

const RISK_CATEGORIES: readonly LocalAccessRiskCategory[] = ['network_egress', 'destructive', 'priv_esc', 'sensitive_path'];

const DEFAULT_LOCAL_ACCESS_SENSITIVE_POLICY: LocalAccessSensitivePolicy = {
  enabled_categories: [...RISK_CATEGORIES],
  sensitive_path_patterns: [
    '(^|/)\\.ssh(/|$)',
    '(^|/)\\.gnupg(/|$)',
    '(^|/)\\.aws(/|$)',
    '(^|/)\\.config/gcloud(/|$)',
    '(^|/)\\.docker/config\\.json$',
    '(^|/)\\.kube/config$',
    '(^|/)\\.netrc$',
    '(^|/)\\.npmrc$',
    '(^|/)\\.pypirc$',
    '(^|/)\\.git-credentials$',
    '(^|/)\\.env(\\.|$)',
    '(^|/)id_(rsa|dsa|ecdsa|ed25519)(\\.pub)?$',
    '\\.pem$',
    '/Keychains(/|$)',
    'login\\.keychain',
    '^~/(Documents|Desktop|Downloads)(/|$)',
    '^~/Library/(Application Support|Containers|Group Containers|Keychains)(/|$)',
  ],
  sensitive_write_path_patterns: [
    '^~/(\\.bashrc|\\.bash_profile|\\.zshrc|\\.zprofile|\\.profile)$',
    '(^|/)\\.ssh/authorized_keys$',
    '/LaunchAgents(/|$)',
    '/LaunchDaemons(/|$)',
    '(^|/)\\.config/systemd(/|$)',
    '/etc/cron',
    '/etc/systemd',
    '(^|/)\\.config/autostart(/|$)',
    '\\\\Start Menu\\\\Programs\\\\Startup',
    '^/etc/',
  ],
  sensitive_command_patterns: [
    { category: 'priv_esc', pattern: '(^|[\\s;&|])(?:sudo|su|doas|pkexec)(?:\\s|$)' },
    { category: 'destructive', pattern: '(^|[\\s;&|])(?:dd|mkfs\\S*|shred|fdisk|parted|sgdisk)(?:\\s|$)' },
    { category: 'network_egress', pattern: '(^|[\\s;&|])(?:ssh|scp|sftp|rsync|nc|ncat|netcat|telnet|socat)(?:\\s|$)' },
    { category: 'sensitive_path', pattern: '(^|[\\s;&|])security\\s+(?:dump-keychain|find-generic-password|find-internet-password|export)\\b' },
    { category: 'sensitive_path', pattern: '(^|[\\s;&|])crontab(?:\\s|$)' },
  ],
};

function isRiskCategory(v: unknown): v is LocalAccessRiskCategory {
  return typeof v === 'string' && (RISK_CATEGORIES as readonly string[]).includes(v);
}

function normalizedStringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
}

function normalizedCategoryList(v: unknown): LocalAccessRiskCategory[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: LocalAccessRiskCategory[] = [];
  for (const x of v) if (isRiskCategory(x) && !out.includes(x)) out.push(x);
  return out.length ? out : undefined;
}

function normalizedCommandPatterns(v: unknown): SensitiveCommandPattern[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SensitiveCommandPattern[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    if (!isRiskCategory(r.category) || typeof r.pattern !== 'string' || !r.pattern.trim()) continue;
    out.push({ category: r.category, pattern: r.pattern.trim() });
  }
  return out.length ? out : undefined;
}

function normalizePolicy(raw: unknown): Partial<LocalAccessSensitivePolicy> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const enabledCategories = normalizedCategoryList(r.enabled_categories);
  const sensitivePathPatterns = normalizedStringList(r.sensitive_path_patterns);
  const sensitiveWritePathPatterns = normalizedStringList(r.sensitive_write_path_patterns);
  const sensitiveCommandPatterns = normalizedCommandPatterns(r.sensitive_command_patterns);
  return {
    ...(enabledCategories ? { enabled_categories: enabledCategories } : {}),
    ...(sensitivePathPatterns ? { sensitive_path_patterns: sensitivePathPatterns } : {}),
    ...(sensitiveWritePathPatterns ? { sensitive_write_path_patterns: sensitiveWritePathPatterns } : {}),
    ...(sensitiveCommandPatterns ? { sensitive_command_patterns: sensitiveCommandPatterns } : {}),
  };
}

function mergeLocalAccessSensitivePolicy(baseRaw: unknown, overrideRaw: unknown): LocalAccessSensitivePolicy {
  const base = { ...DEFAULT_LOCAL_ACCESS_SENSITIVE_POLICY, ...normalizePolicy(baseRaw) };
  const override = normalizePolicy(overrideRaw);
  return {
    enabled_categories: override.enabled_categories ?? base.enabled_categories,
    sensitive_path_patterns: override.sensitive_path_patterns ?? base.sensitive_path_patterns,
    sensitive_write_path_patterns: override.sensitive_write_path_patterns ?? base.sensitive_write_path_patterns,
    sensitive_command_patterns: override.sensitive_command_patterns ?? base.sensitive_command_patterns,
  };
}

clientConfig.registerDefault<LocalAccessSensitivePolicy>(
  'local_access.sensitive_policy',
  DEFAULT_LOCAL_ACCESS_SENSITIVE_POLICY,
  { effect: 'immediate', merge: mergeLocalAccessSensitivePolicy },
);

export function getLocalAccessSensitivePolicy(): LocalAccessSensitivePolicy {
  return clientConfig.get<LocalAccessSensitivePolicy>(
    'local_access.sensitive_policy',
    DEFAULT_LOCAL_ACCESS_SENSITIVE_POLICY,
  ) || DEFAULT_LOCAL_ACCESS_SENSITIVE_POLICY;
}

function compile(pattern: string): RegExp | null {
  try { return new RegExp(pattern, 'i'); }
  catch { return null; }
}

function pathHaystack(absPath: string): string {
  const resolved = path.resolve(absPath).split(path.sep).join('/');
  const home = os.homedir() ? path.resolve(os.homedir()).split(path.sep).join('/') : '';
  const tilde = home && (resolved === home || resolved.startsWith(`${home}/`))
    ? `~${resolved.slice(home.length)}`
    : '';
  return tilde ? `${resolved}\n${tilde}` : resolved;
}

function patternsMatch(patterns: string[], haystack: string): boolean {
  for (const pattern of patterns) {
    const re = compile(pattern);
    if (re?.test(haystack)) return true;
  }
  return false;
}

export function sensitivePathReasons(absPath: string, access: 'read' | 'write' = 'read'): LocalAccessRiskCategory[] {
  const policy = getLocalAccessSensitivePolicy();
  if (!policy.enabled_categories.includes('sensitive_path')) return [];
  const haystack = pathHaystack(absPath);
  if (patternsMatch(policy.sensitive_path_patterns, haystack)) return ['sensitive_path'];
  if (access === 'write' && patternsMatch(policy.sensitive_write_path_patterns, haystack)) return ['sensitive_path'];
  return [];
}

export function classifyConfiguredBashCommand(
  command: string,
  baseReasons: readonly LocalAccessRiskCategory[] = [],
  options: { includePathPatterns?: boolean } = {},
): LocalAccessRiskCategory[] {
  const policy = getLocalAccessSensitivePolicy();
  const enabled = new Set(policy.enabled_categories);
  const reasons = new Set<LocalAccessRiskCategory>();
  for (const r of baseReasons) if (enabled.has(r)) reasons.add(r);

  const text = String(command || '');
  if (text.trim()) {
    for (const item of policy.sensitive_command_patterns) {
      if (!enabled.has(item.category)) continue;
      const re = compile(item.pattern);
      if (re?.test(text)) reasons.add(item.category);
    }
    if (options.includePathPatterns !== false && enabled.has('sensitive_path')) {
      const normalized = text.replace(/\\/g, '/');
      if (patternsMatch(policy.sensitive_path_patterns, normalized)) reasons.add('sensitive_path');
      if (patternsMatch(policy.sensitive_write_path_patterns, normalized)) reasons.add('sensitive_path');
    }
  }

  return [...reasons];
}
