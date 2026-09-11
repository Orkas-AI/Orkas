/** Reviewed immutable pins for official local connector CLIs. Pure data: safe for catalog import. */
export const LOCAL_CLI_MANIFESTS = Object.freeze({
  wecom: Object.freeze({
    provider: 'wecom' as const,
    package_name: '@wecom/cli',
    package_version: '1.2.0',
    package_integrity: 'sha512-GaVCie2We3EWrOiIYlXp5FpjznikbS1oShFyZjIz2uDDdQlkbA8CJzjhzrAzRgIDU/oaxpmEucp9WHN/yiuzuQ==',
    executable: 'wecom-cli',
    allowed_domains: Object.freeze([
      'calendar', 'chat', 'contact', 'disk', 'doc', 'identity', 'mail', 'media', 'message',
      'meeting', 'sheet', 'smartpage', 'smartsheet', 'todo',
    ]),
  }),
  lark: Object.freeze({
    provider: 'lark' as const,
    package_name: '@larksuite/cli',
    package_version: '1.0.93',
    package_integrity: 'sha512-QARcHz96pfEzzRZdjXene5h9fJ46lCu5q2TWx+blLyOIXEPuJwi6bT+RT9hPOsKFW+bbGYvamU8LpD6FsIa5ew==',
    executable: 'lark-cli',
    allowed_domains: Object.freeze([
      'approval', 'attendance', 'base', 'calendar', 'contact', 'docs', 'drive', 'im',
      'mail', 'markdown', 'mindnotes', 'minutes', 'note', 'okr', 'sheets', 'slides',
      'task', 'vc', 'wiki',
    ]),
  }),
  dingtalk: Object.freeze({
    provider: 'dingtalk' as const,
    package_name: 'dingtalk-workspace-cli',
    package_version: '1.0.61',
    package_integrity: 'sha512-lYLLqE3jDRqzf3ekjaOnBqD222fsbRkEiO4GsR6k8aMiybEUTQDr7BC9/4Wtm2KeL+PiukBqfZ9EFULS22jdBA==',
    executable: 'dws',
    allowed_domains: Object.freeze([
      'agoal', 'aisearch', 'aitable', 'attendance', 'calendar', 'chat', 'contact', 'ding',
      'doc', 'drive', 'hrbrain', 'live', 'mail', 'minutes', 'oa', 'recruit', 'report',
      'sheet', 'todo', 'whiteboard', 'wiki',
    ]),
  }),
  xero: Object.freeze({
    provider: 'xero' as const,
    package_name: '@xeroapi/xero-command-line',
    package_version: '0.0.7',
    package_integrity: 'sha512-H0GITjyzP7Zek/6zinvpOjY/Ed7nyf21c9n+hzi81lTFrRp/foMRwL6Gx7IktsOyeo0DSJ4Y/y6VqNrwyiodEA==',
    executable: 'xero',
    allowed_domains: Object.freeze([
      'accounts', 'bank-transactions', 'contact-groups', 'contacts', 'credit-notes',
      'currencies', 'invoices', 'items', 'manual-journals', 'org', 'payments', 'quotes',
      'reports', 'tax-rates', 'tracking',
    ]),
  }),
});
