import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';

/** Keep report evidence at its original path, but load local HTML through a
 * short path that Chromium's Windows file loader can open. The fixture's
 * absolute base URL continues to own script, stylesheet and font resolution. */
export async function loadRetainedFilePage(page: Page, retainedFile: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-page-'));
  const file = path.join(directory, 'index.html');
  try {
    fs.copyFileSync(retainedFile, file);
    await page.goto(pathToFileURL(file).href);
  } finally {
    // These fixtures do not reload the document after initial navigation.
    // Remove only the two exact entries created above, never a recursive tree.
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
}
