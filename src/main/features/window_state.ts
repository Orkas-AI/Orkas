import { screen, type BrowserWindow, type BrowserWindowConstructorOptions, type Rectangle } from 'electron';

import { WINDOW_STATE_FILE } from '../paths';
import { readJsonSync, writeJsonSync } from '../storage';
import { createLogger } from '../logger';

const DEFAULT_BOUNDS: Pick<Rectangle, 'width' | 'height'> = { width: 1280, height: 800 };
const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;
const MIN_VISIBLE_PX = 80;
const log = createLogger('window-state');

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

function clampDimension(value: unknown, min: number, max: number, fallback: number): number {
  const n = finiteInt(value);
  const effectiveMax = Math.max(min, max);
  const requested = n === null || n <= 0 ? fallback : n;
  return Math.min(Math.max(requested, min), effectiveMax);
}

function intersectionSize(a: Rectangle, b: Rectangle): Pick<Rectangle, 'width' | 'height'> {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return {
    width: Math.max(0, x2 - x1),
    height: Math.max(0, y2 - y1),
  };
}

function hasVisiblePosition(bounds: Rectangle, areas: Rectangle[]): boolean {
  return areas.some((area) => {
    const overlap = intersectionSize(bounds, area);
    return overlap.width >= MIN_VISIBLE_PX && overlap.height >= MIN_VISIBLE_PX;
  });
}

function targetWorkArea(raw: SavedWindowState, areas: Rectangle[]): Rectangle {
  const primary = screen.getPrimaryDisplay().workArea;
  const x = finiteInt(raw.x);
  const y = finiteInt(raw.y);
  if (x === null || y === null) return primary;
  const width = finiteInt(raw.width);
  const height = finiteInt(raw.height);
  const candidate: Rectangle = {
    x,
    y,
    width: width !== null && width > 0 ? width : DEFAULT_BOUNDS.width,
    height: height !== null && height > 0 ? height : DEFAULT_BOUNDS.height,
  };
  let selected = primary;
  let selectedOverlap = 0;
  for (const area of areas) {
    const overlap = intersectionSize(candidate, area);
    const overlapArea = overlap.width * overlap.height;
    if (overlapArea > selectedOverlap) {
      selected = area;
      selectedOverlap = overlapArea;
    }
  }
  return selected;
}

function sanitizeBounds(raw: SavedWindowState): BrowserWindowConstructorOptions {
  const areas = workAreas();
  const target = targetWorkArea(raw, areas);
  const width = clampDimension(raw.width, MIN_WIDTH, target.width, DEFAULT_BOUNDS.width);
  const height = clampDimension(raw.height, MIN_HEIGHT, target.height, DEFAULT_BOUNDS.height);
  const x = finiteInt(raw.x);
  const y = finiteInt(raw.y);
  if (x === null || y === null) return { width, height };

  const positioned = { x, y, width, height };
  if (!hasVisiblePosition(positioned, areas)) return { width, height };
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
  try {
    if (win.isDestroyed() || win.isMinimized()) return;
    const isMaximized = win.isMaximized();
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
    writeJsonSync(WINDOW_STATE_FILE, {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized,
    } satisfies SavedWindowState);
  } catch (err) {
    log.warn('window state persistence failed', {
      error_code: (err as NodeJS.ErrnoException | undefined)?.code || 'unknown',
    });
  }
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
