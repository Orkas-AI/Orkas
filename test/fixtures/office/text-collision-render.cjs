// Real Chromium layout oracle. No application account or network is used.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const root = process.argv[2];
require(path.join(root, 'node_modules/tsx/dist/cjs/index.cjs'));
const { PPTX_TEXT_COLLISION_SCRIPT } = require(path.join(root, 'src/main/features/office/pptx_text_collision.ts'));
const { hardenedWebPreferences } = require(path.join(root, 'src/main/util/window-security.ts'));
const shape = (id, x, y, text, css = '') => `<div class="shape" data-path="/slide[1]/shape[@id=${id}]" style="left:${x}px;top:${y}px;${css.replace(/"/g, "&quot;")}"><div class="shape-text"><span>${text}</span></div></div>`;
const overlap = shape(1, 10, 10, 'ABCDEFG') + shape(2, 85, 10, 'XYZ');
const cases = {
  collision: overlap,
  observedCjkPair: shape(100114, 91.2, 494.4, '需要客户确认的信息', 'width:220.8px;font: bold 24px/24px "Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif')
    + shape(100115, 297.6, 491.52, '目标部门 · 可接入知识源 · 安全合规要求 · 试点成功口径 · 项目联系人', 'width:796.8px;font:22.667px/22.667px "Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif'),
  background: '<div style="position:absolute;inset:0;background:#abc"></div>' + shape(1, 10, 10, 'Foreground'),
  emptyBoxes: shape(1, 10, 10, 'Short', 'width:500px') + shape(2, 300, 10, 'Apart'),
  whitespace: shape(1, 10, 10, 'AB   CD') + shape(2, 46, 10, 'X'),
  wrapped: shape(1, 10, 10, 'AB<br>CD') + shape(2, 80, 10, 'X'),
  clipping: shape(1, 10, 10, 'ABCDEFG', 'width:24px;overflow:hidden') + shape(2, 50, 10, 'XYZ'),
  hidden: overlap + shape(3, 10, 10, 'Invisible', 'display:none'),
  transparent: shape(1, 10, 10, 'ABCDEFG', 'color:transparent') + shape(2, 85, 10, 'XYZ'),
  rotated: shape(1, 10, 10, 'ABCDEFG', 'transform:rotate(20deg)') + shape(2, 85, 10, 'XYZ'),
  effect: shape(1, 10, 10, 'ABCDEFG', 'text-shadow:1px 1px black') + shape(2, 85, 10, 'XYZ'),
  decorative: shape(1, 10, 10, 'TITLE') + shape(2, 10, 10, 'TITLE'),
  unsupported: '<table><tr><td>Outside shape layout</td></tr></table>',
  budget: shape(1, 10, 10, 'X'.repeat(20000)),
};
app.whenReady().then(async () => {
  const ses = session.fromPartition('collision-test');
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith('data:') }));
  const win = new BrowserWindow({ show: false, width: 800, height: 600, useContentSize: true, webPreferences: hardenedWebPreferences({ session: ses, backgroundThrottling: false }) });
  try {
    const results = {};
    for (const [name, body] of Object.entries(cases)) {
      const html = '<!doctype html><style>body{margin:0}.slide{position:relative;width:800px;height:600px}.shape{position:absolute;width:300px;height:60px;white-space:pre-wrap;font:20px/24px monospace}.shape-text{width:100%;height:100%}</style><div class="slide">' + body + '</div>';
      await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
      await win.webContents.executeJavaScript('document.fonts.ready');
      results[name] = await win.webContents.executeJavaScript(PPTX_TEXT_COLLISION_SCRIPT);
    }
    fs.writeFileSync(process.argv[3], JSON.stringify(results));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { win.destroy(); await ses.clearStorageData(); app.exit(process.exitCode || 0); }
});
