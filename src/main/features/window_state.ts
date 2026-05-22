import { screen, type BrowserWindow, type BrowserWindowConstructorOptions, type Rectangle } from 'electron';

import { WINDOW_STATE_FILE } from '../paths';
import { readJsonSync, writeJsonSync } from '../storage';

const DEFAULT_BOUNDS: Pick<Rectangle, 'width' | 'height'> = { width: 1280, height: 800 };
const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;
const MIN_VISIBLE_PX = 80;

export interface SavedWindowState {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isMaximized?: boolean;
}

export interface RestoredWindowState {
  bounds: BrowserWindowConstructorOptions;
  isMaximized: boolean;
}

type WindowStateSource = Pick<
  BrowserWindow,
  'getBounds' | 'getNormalBounds' | 'isDestroyed' | 'isMaximized' | 'isMinimized'
>;

function finiteInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value);
}

function workAreas(): Rectangle[] {
  const displays = screen.getAllDisplays();
  if (displays.length) return displays.map((d) => d.workArea);
  return [screen.getPrimaryDisplay().workArea];
}

function maxWorkAreaSize(): Pick<Rectangle, 'width' | 'height'> {
  return workAreas().reduce(
    (acc, area) => ({
      width: Math.max(acc.width, area.width),
      height: Math.max(acc.height, area.height),
    }),
    { width: DEFAULT_BOUNDS.width, height: DEFAULT_BOUNDS.height },
  );
}

function clampDimension(value: unknown, min: number, max: number, fallback: number): number {
  const n = finiteInt(value);
  if (n === null || n <= 0) return fallback;
  const effectiveMax = Math.max(min, max);
  return Math.min(Math.max(n, min), effectiveMax);
}

function intersects(a: Rectangle, b: Rectangle): boolean {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return x2 - x1 >= MIN_VISIBLE_PX && y2 - y1 >= MIN_VISIBLE_PX;
}

function hasVisiblePosition(bounds: Rectangle): boolean {
  return workAreas().some((area) => intersects(bounds, area));
}

function sanitizeBounds(raw: SavedWindowState): BrowserWindowConstructorOptions {
  const max = maxWorkAreaSize();
  const width = clampDimension(raw.width, MIN_WIDTH, max.width, DEFAULT_BOUNDS.width);
  const height = clampDimension(raw.height, MIN_HEIGHT, max.height, DEFAULT_BOUNDS.height);
  const x = finiteInt(raw.x);
  const y = finiteInt(raw.y);
  if (x === null || y === null) return { width, height };

  const positioned = { x, y, width, height };
  if (!hasVisiblePosition(positioned)) return { width, height };
  return positioned;
}

export function restoreWindowState(): RestoredWindowState {
  const raw = readJsonSync<SavedWindowState>(WINDOW_STATE_FILE);
  const bounds = sanitizeBounds(raw);
  return {
    bounds,
    isMaximized: raw.isMaximized === true,
  };
}

export function saveWindowStateNow(win: WindowStateSource): void {
  if (win.isDestroyed() || win.isMinimized()) return;
  const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
  writeJsonSync(WINDOW_STATE_FILE, {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized(),
  } satisfies SavedWindowState);
}

export function watchWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;
  const scheduleSave = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      saveWindowStateNow(win);
    }, 300);
    timer.unref?.();
  };
  const saveNow = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    saveWindowStateNow(win);
  };

  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);
  win.on('close', saveNow);
}
