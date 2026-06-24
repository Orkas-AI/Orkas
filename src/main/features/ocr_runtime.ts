/**
 * Local OCR runtime for `ocr_file`.
 *
 * Default engine: RapidOCR + ONNXRuntime CPU. PDF pages are rendered inside
 * the same isolated Python venv with pypdfium2, then passed to RapidOCR as
 * images. Callers get OCR markdown or a stable E_OCR_* error, both with
 * process information suitable for the model to reason about what happened.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  PYTHON_VENV_PIP_CACHE_DIR,
  PYTHON_VENV_UV_CACHE_DIR,
  pythonPackageVenvDir,
  userFileCacheDir,
} from '../paths';
import { bundledRuntimeEnv } from '../util/bundled-runtime';
import { createLogger } from '../logger';

const execFileAsync = promisify(execFile);
const log = createLogger('ocr-runtime');

export const OCR_RUNTIME_KEY = `ocr-rapidocr-3.9.0-onnxruntime-1.27.0-pypdfium2-5.10.1-${process.platform}-${process.arch}`;
const RAPIDOCR_VERSION = '3.9.0';
const ONNXRUNTIME_VERSION = '1.27.0';
const PYPDFIUM2_VERSION = '5.10.1';
const CACHE_VERSION = 1;
const OCR_TIMEOUT_MS = 5 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 2 * 60 * 1000;
const OCR_PROGRESS_HEARTBEAT_MS = 30_000;

export interface OcrFileInput {
  userId: string;
  absPath: string;
  pages?: string;
  signal?: AbortSignal;
  onProgress?: (event: { phase: string; message: string; data?: Record<string, unknown> }) => void;
}

type ProgressFn = NonNullable<OcrFileInput['onProgress']>;

export type OcrFileResult =
  | {
      ok: true;
      content: string;
      pages: number[];
      cached: boolean;
      engine: string;
      processLog: string[];
    }
  | {
      ok: false;
      errorCode:
        | 'E_OCR_RUNTIME_MISSING'
        | 'E_OCR_INSTALL_FAILED'
        | 'E_OCR_UNSUPPORTED_FILE'
        | 'E_OCR_FAILED'
        | 'E_BAD_INPUT';
      message: string;
      processLog: string[];
    };

interface RuntimeReady {
  ok: true;
  python: string;
  venv: string;
  installed: boolean;
}

interface RuntimeMissing {
  ok: false;
  errorCode: 'E_OCR_RUNTIME_MISSING' | 'E_OCR_INSTALL_FAILED';
  message: string;
}

type RuntimeResult = RuntimeReady | RuntimeMissing;

type RuntimeVerification =
  | { ok: true }
  | { ok: false; message: string };

function venvDir(): string {
  return pythonPackageVenvDir(OCR_RUNTIME_KEY);
}

function venvPython(venv = venvDir()): string {
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); }
  catch { return false; }
}

function runtimeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...bundledRuntimeEnv(),
    PYTHONNOUSERSITE: '1',
    UV_CACHE_DIR: PYTHON_VENV_UV_CACHE_DIR,
    PIP_CACHE_DIR: PYTHON_VENV_PIP_CACHE_DIR,
  };
}

async function withHeartbeat<T>(
  promise: Promise<T>,
  onProgress: ProgressFn | undefined,
  phase: string,
  heartbeatMessage: string,
): Promise<T> {
  let tick = 0;
  const timer = onProgress
    ? setInterval(() => {
        tick += 1;
        onProgress({
          phase,
          message: heartbeatMessage,
          data: { heartbeat: true, seconds: tick * (OCR_PROGRESS_HEARTBEAT_MS / 1000) },
        });
      }, OCR_PROGRESS_HEARTBEAT_MS)
    : null;
  try {
    return await promise;
  } finally {
    if (timer) clearInterval(timer);
  }
}

const VERIFY_RUNTIME_SCRIPT = String.raw`
import pathlib
import pypdfium2
import onnxruntime
import rapidocr as rapidocr_pkg
from rapidocr import RapidOCR

model_dir = pathlib.Path(rapidocr_pkg.__file__).resolve().parent / "models"
RapidOCR(params={"Global.model_root_dir": str(model_dir)})
print("ok")
`;

async function verifyRuntime(python: string, onProgress?: ProgressFn): Promise<RuntimeVerification> {
  if (!isFile(python)) return { ok: false, message: `Python executable is missing: ${python}` };
  try {
    await withHeartbeat(
      execFileAsync(
        python,
        ['-c', VERIFY_RUNTIME_SCRIPT],
        { timeout: VERIFY_TIMEOUT_MS, env: runtimeEnv(), windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      ),
      onProgress,
      'ocr_runtime_verify',
      'Still checking local OCR runtime',
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

async function ensureRuntime(onProgress?: ProgressFn): Promise<RuntimeResult> {
  const venv = venvDir();
  const python = venvPython(venv);
  onProgress?.({ phase: 'ocr_runtime_check', message: 'Checking local OCR runtime' });
  const existingVerification = await verifyRuntime(python, onProgress);
  if (existingVerification.ok === true) {
    onProgress?.({ phase: 'ocr_runtime_ready', message: 'Local OCR runtime is ready' });
    return { ok: true, python, venv, installed: false };
  }

  const env = runtimeEnv();
  const uv = env.ORKAS_UV;
  const bundledPython = env.ORKAS_PYTHON;
  if (!uv || !bundledPython) {
    onProgress?.({ phase: 'ocr_runtime_missing', message: 'Bundled Python/uv runtime is unavailable' });
    return {
      ok: false,
      errorCode: 'E_OCR_RUNTIME_MISSING',
      message: 'Bundled Python/uv runtime is unavailable, so Local OCR cannot be installed on this build.',
    };
  }

  try {
    fs.mkdirSync(path.dirname(venv), { recursive: true });
    onProgress?.({
      phase: 'ocr_runtime_install',
      message: 'Creating local OCR Python environment',
      data: { runtimePath: venv },
    });
    await withHeartbeat(
      execFileAsync(uv, ['venv', '--python', bundledPython, venv], {
        timeout: INSTALL_TIMEOUT_MS,
        env,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }),
      onProgress,
      'ocr_runtime_install',
      'Still creating local OCR Python environment',
    );
    onProgress?.({
      phase: 'ocr_runtime_install',
      message: 'Downloading and installing local OCR packages',
      data: {
        packages: [
          `rapidocr==${RAPIDOCR_VERSION}`,
          `onnxruntime==${ONNXRUNTIME_VERSION}`,
          `pypdfium2==${PYPDFIUM2_VERSION}`,
        ],
      },
    });
    await withHeartbeat(
      execFileAsync(
        uv,
        [
          'pip', 'install',
          '--python', venvPython(venv),
          '--only-binary=:all:',
          `rapidocr==${RAPIDOCR_VERSION}`,
          `onnxruntime==${ONNXRUNTIME_VERSION}`,
          `pypdfium2==${PYPDFIUM2_VERSION}`,
        ],
        {
          timeout: INSTALL_TIMEOUT_MS,
          env,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        },
      ),
      onProgress,
      'ocr_runtime_install',
      'Still installing local OCR packages',
    );
    onProgress?.({ phase: 'ocr_runtime_verify', message: 'Verifying local OCR runtime' });
  } catch (err) {
    log.warn(`install failed: ${(err as Error).message}`);
    onProgress?.({
      phase: 'ocr_runtime_install_failed',
      message: 'Local OCR runtime install failed',
      data: { error: (err as Error).message },
    });
    return {
      ok: false,
      errorCode: 'E_OCR_INSTALL_FAILED',
      message: `Local OCR runtime install failed: ${(err as Error).message}`,
    };
  }

  const installedVerification = await verifyRuntime(python, onProgress);
  if (installedVerification.ok === true) {
    onProgress?.({ phase: 'ocr_runtime_ready', message: 'Local OCR runtime installed and ready' });
    return { ok: true, python, venv, installed: true };
  }
  onProgress?.({ phase: 'ocr_runtime_install_failed', message: 'Local OCR runtime verification failed' });
  return {
    ok: false,
    errorCode: 'E_OCR_INSTALL_FAILED',
    message: `Local OCR runtime installed, but verification failed: ${installedVerification.message}`,
  };
}

async function runOcrProcess(
  python: string,
  payload: string,
  onProgress: ProgressFn | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const res = await withHeartbeat(
    execFileAsync(python, ['-c', PYTHON_OCR_SCRIPT, payload], {
      timeout: OCR_TIMEOUT_MS,
      env: runtimeEnv(),
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    }),
    onProgress,
    'ocr_run',
    'Still running local OCR',
  );
  return res.stdout;
}

function extKind(absPath: string): 'pdf' | 'image' | 'unsupported' {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image';
  return 'unsupported';
}

function cleanPages(pages: string | undefined): string {
  return String(pages || '').replace(/\s+/g, '').trim();
}

function fileFingerprint(absPath: string): { size: number; mtime: number } {
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) throw new Error(`not a file: ${absPath}`);
  return { size: stat.size, mtime: Math.floor(stat.mtimeMs) };
}

function hash(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function cachePaths(userId: string, absPath: string, pages: string): { dir: string; file: string } {
  const fp = fileFingerprint(absPath);
  const sourceHash = hash(absPath).slice(0, 16);
  const taskHash = hash(JSON.stringify({
    cacheVersion: CACHE_VERSION,
    absPath,
    size: fp.size,
    mtime: fp.mtime,
    pages,
    runtime: OCR_RUNTIME_KEY,
  })).slice(0, 16);
  const dir = path.join(userFileCacheDir(userId), sourceHash);
  return { dir, file: path.join(dir, `ocr.${taskHash}.md`) };
}

function formatProcessLog(processLog: string[]): string {
  if (!processLog.length) return '';
  return [
    '<ocr-process>',
    ...processLog.map((line) => `- ${line}`),
    '</ocr-process>',
    '',
  ].join('\n');
}

function renderMarkdown(args: {
  absPath: string;
  kind: 'pdf' | 'image';
  pages: Array<{ page: number; text: string; items: Array<{ text: string; score?: number }> }>;
  cached: boolean;
  processLog: string[];
}): string {
  const pageNums = args.pages.map((p) => p.page);
  const pageAttr = pageNums.length ? pageNums.join(',') : '1';
  const lines: string[] = [
    formatProcessLog(args.processLog),
    `<ocr-file path="${escapeXml(args.absPath)}" kind="${args.kind}" pages="${escapeXml(pageAttr)}" engine="local:rapidocr-onnxruntime" cached="${args.cached ? 'true' : 'false'}">`,
    '',
  ];
  for (const p of args.pages) {
    lines.push(`## Page ${p.page}`, '');
    const text = p.text.trim();
    lines.push(text || '[No text detected]');
    lines.push('');
  }
  lines.push('</ocr-file>');
  return lines.join('\n').trimEnd();
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function ocrFile(input: OcrFileInput): Promise<OcrFileResult> {
  const processLog: string[] = [];
  const emitProgress: ProgressFn = (event) => {
    const suffix = event.data?.seconds ? ` (${event.data.seconds}s)` : '';
    processLog.push(`${event.message}${suffix}`);
    input.onProgress?.(event);
  };
  const kind = extKind(input.absPath);
  if (kind === 'unsupported') {
    return {
      ok: false,
      errorCode: 'E_OCR_UNSUPPORTED_FILE',
      message: 'ocr_file currently supports PDF and image files only. Use read_file for normal text/Office files.',
      processLog,
    };
  }

  let pages = cleanPages(input.pages);
  const { file: cacheFile, dir: cacheDir } = cachePaths(input.userId, input.absPath, pages);
  try {
    if (fs.existsSync(cacheFile)) {
      const content = fs.readFileSync(cacheFile, 'utf8')
        .replace(/<ocr-process>[\s\S]*?<\/ocr-process>\s*/m, '')
        .replace('cached="false"', 'cached="true"');
      processLog.push('Using cached OCR result');
      return {
        ok: true,
        content: `${formatProcessLog(processLog)}${content}`,
        pages: [],
        cached: true,
        engine: 'local:rapidocr-onnxruntime',
        processLog,
      };
    }
  } catch { /* best effort */ }

  emitProgress({ phase: 'ocr_prepare', message: 'Preparing local OCR runtime' });
  const runtime = await ensureRuntime(emitProgress);
  if (runtime.ok === false) {
    return { ok: false, errorCode: runtime.errorCode, message: runtime.message, processLog };
  }

  emitProgress({ phase: 'ocr_run', message: kind === 'pdf' ? 'Rendering PDF pages and running OCR' : 'Running OCR' });
  const payload = JSON.stringify({
    path: input.absPath,
    kind,
    pages,
    scale: 2,
  });

  let stdout = '';
  try {
    stdout = await runOcrProcess(runtime.python, payload, emitProgress, input.signal);
  } catch (err) {
    log.warn(`ocr failed path=${input.absPath}: ${(err as Error).message}`);
    processLog.push('Local OCR process failed');
    return {
      ok: false,
      errorCode: 'E_OCR_FAILED',
      message: `Local OCR failed: ${(err as Error).message}`,
      processLog,
    };
  }

  try {
    const parsed = JSON.parse(stdout);
    if (!parsed?.ok) {
      processLog.push('Local OCR returned an error');
      return {
        ok: false,
        errorCode: 'E_OCR_FAILED',
        message: String(parsed?.error || 'Local OCR failed'),
        processLog,
      };
    }
    const pageResults = Array.isArray(parsed.pages) ? parsed.pages : [];
    processLog.push(`OCR completed for ${pageResults.length || 0} page${pageResults.length === 1 ? '' : 's'}`);
    const content = renderMarkdown({ absPath: input.absPath, kind, pages: pageResults, cached: false, processLog });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, content, 'utf8');
    return {
      ok: true,
      content,
      pages: pageResults.map((p: { page: number }) => p.page).filter((n: unknown): n is number => typeof n === 'number'),
      cached: false,
      engine: 'local:rapidocr-onnxruntime',
      processLog,
    };
  } catch (err) {
    processLog.push('Local OCR returned invalid output');
    return {
      ok: false,
      errorCode: 'E_OCR_FAILED',
      message: `Local OCR returned invalid output: ${(err as Error).message}`,
      processLog,
    };
  }
}

// Keep this script dependency-light and resilient across RapidOCR package API
// changes. The pinned `rapidocr` package needs a string model_root_dir here:
// passing its default pathlib.Path trips OmegaConf on some Python versions.
const PYTHON_OCR_SCRIPT = String.raw`
import json, os, pathlib, sys, tempfile, traceback

def load_engine():
    try:
        import rapidocr as rapidocr_pkg
        from rapidocr import RapidOCR
    except ModuleNotFoundError as exc:
        if exc.name != "rapidocr":
            raise
        try:
            from rapidocr_onnxruntime import RapidOCR
            return RapidOCR()
        except ModuleNotFoundError:
            raise exc
    model_dir = pathlib.Path(rapidocr_pkg.__file__).resolve().parent / "models"
    return RapidOCR(params={"Global.model_root_dir": str(model_dir)})

def parse_pages(spec, total):
    if not spec:
        return list(range(1, total + 1))
    out = []
    for part in str(spec).split(","):
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            start, end = int(a), int(b)
            if start > end:
                start, end = end, start
            out.extend(range(start, end + 1))
        else:
            out.append(int(part))
    seen = []
    for n in out:
        if n < 1 or n > total:
            raise ValueError(f"page {n} out of range 1-{total}")
        if n not in seen:
            seen.append(n)
    return seen

def item_text(item):
    if isinstance(item, dict):
        txt = item.get("text") or item.get("txt") or item.get("label")
        score = item.get("score") or item.get("confidence")
        return txt, score
    if isinstance(item, (list, tuple)):
        if len(item) >= 2 and isinstance(item[1], str):
            return item[1], item[2] if len(item) >= 3 and isinstance(item[2], (int, float)) else None
        if len(item) >= 1 and isinstance(item[0], str):
            return item[0], item[1] if len(item) >= 2 and isinstance(item[1], (int, float)) else None
    if isinstance(item, str):
        return item, None
    return None, None

def collect_result(result):
    if isinstance(result, tuple) and result:
        # rapidocr_onnxruntime returns (results, elapsed)
        result = result[0]
    if hasattr(result, "txts"):
        txts = list(getattr(result, "txts") or [])
        scores = list(getattr(result, "scores", []) or [])
        return [{"text": str(t), **({"score": float(scores[i])} if i < len(scores) and isinstance(scores[i], (int, float)) else {})} for i, t in enumerate(txts) if str(t).strip()]
    if hasattr(result, "to_json"):
        try:
            return collect_result(json.loads(result.to_json()))
        except Exception:
            pass
    if isinstance(result, dict):
        if "txts" in result:
            txts = result.get("txts") or []
            scores = result.get("scores") or []
            return [{"text": str(t), **({"score": float(scores[i])} if i < len(scores) and isinstance(scores[i], (int, float)) else {})} for i, t in enumerate(txts) if str(t).strip()]
        for key in ("data", "result", "results"):
            if key in result:
                return collect_result(result[key])
    if isinstance(result, list):
        out = []
        for item in result:
            if isinstance(item, (list, tuple, dict, str)):
                txt, score = item_text(item)
                if txt and str(txt).strip():
                    obj = {"text": str(txt)}
                    if isinstance(score, (int, float)):
                        obj["score"] = float(score)
                    out.append(obj)
                elif not isinstance(item, str):
                    out.extend(collect_result(item))
        return out
    return []

def run_ocr(engine, image_path):
    result = engine(image_path)
    items = collect_result(result)
    return {
        "text": "\n".join([i["text"] for i in items if i.get("text")]).strip(),
        "items": items,
    }

def main():
    args = json.loads(sys.argv[1])
    src = args["path"]
    kind = args["kind"]
    engine = load_engine()
    pages = []
    if kind == "image":
        r = run_ocr(engine, src)
        pages.append({"page": 1, **r})
    elif kind == "pdf":
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(src)
        page_nums = parse_pages(args.get("pages") or "", len(pdf))
        scale = float(args.get("scale") or 2)
        with tempfile.TemporaryDirectory(prefix="orkas-ocr-") as td:
            for pno in page_nums:
                page = pdf.get_page(pno - 1)
                try:
                    try:
                        pil = page.render(scale=scale).to_pil()
                    except AttributeError:
                        pil = page.render_topil(scale=scale)
                    out = os.path.join(td, f"page-{pno}.png")
                    pil.save(out, "PNG")
                    r = run_ocr(engine, out)
                    pages.append({"page": pno, **r})
                finally:
                    try:
                        page.close()
                    except Exception:
                        pass
    else:
        raise ValueError(f"unsupported kind: {kind}")
    print(json.dumps({"ok": True, "pages": pages}, ensure_ascii=False))

try:
    main()
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc), "trace": traceback.format_exc()}, ensure_ascii=False))
`;
