#!/usr/bin/env node
'use strict';

const { app, BrowserWindow } = require('electron');

const timeout = setTimeout(() => {
  console.error('[linux-electron-smoke] timed out waiting for Electron');
  app.exit(1);
}, 30_000);

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    await window.loadURL('data:text/html;charset=utf-8,%3Cbody%3Eorkas-linux-smoke%3C%2Fbody%3E');
    const text = await window.webContents.executeJavaScript('document.body.textContent');
    if (text !== 'orkas-linux-smoke') throw new Error('hidden BrowserWindow did not render expected content');
    console.log('[linux-electron-smoke] Electron app and hidden BrowserWindow are ready');
    clearTimeout(timeout);
    window.destroy();
    app.quit();
  } catch (err) {
    clearTimeout(timeout);
    window.destroy();
    console.error(`[linux-electron-smoke] failed: ${err.message}`);
    app.exit(1);
  }
}).catch((err) => {
  clearTimeout(timeout);
  console.error(`[linux-electron-smoke] failed: ${err.message}`);
  app.exit(1);
});
