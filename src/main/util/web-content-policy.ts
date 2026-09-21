/** Browser resources are independent of host/SDK authorization. */
export function webContentCsp(local = "'self'"): string {
  return ["default-src 'none'",
    `script-src ${local} http: https: 'unsafe-inline' 'unsafe-eval' blob:`,
    `style-src ${local} http: https: 'unsafe-inline'`,
    `img-src ${local} http: https: data: blob:`,
    `font-src ${local} http: https: data: blob:`,
    `media-src ${local} http: https: data: blob:`,
    `connect-src ${local} http: https: ws: wss:`,
    `worker-src ${local} http: https: blob:`,
    `frame-src ${local} http: https:`,
    `form-action ${local} http: https:`,
    `manifest-src ${local} http: https:`,
    "object-src 'none'", "base-uri 'self'"].join('; ');
}
