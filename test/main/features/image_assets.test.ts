import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  inspectImageAssetBuffer,
  writeImageAssetBuffer,
} from '../../../src/main/features/image_assets';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let root = '';
let projectDir = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-image-assets-'));
  projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('image asset materialization', () => {
  it('inspects valid image bytes and rejects empty, unreadable, and oversized inputs', async () => {
    await expect(inspectImageAssetBuffer(PNG_1X1)).resolves.toMatchObject({
      format: 'png',
      width: 1,
      height: 1,
      channels: 4,
      bytes: PNG_1X1.length,
    });
    await expect(inspectImageAssetBuffer(Buffer.alloc(0)))
      .rejects.toThrow('image response is empty');
    await expect(inspectImageAssetBuffer(Buffer.from('not-an-image')))
      .rejects.toThrow('not a readable image');
    await expect(inspectImageAssetBuffer(Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="1"/>',
    ))).rejects.toThrow('exceeds the image dimension limit');
  });

  it('transcodes to the requested format and reports deterministic zero-model metadata', async () => {
    const output = path.join(projectDir, 'nested', 'result.jpg');

    const result = await writeImageAssetBuffer({
      projectDirAbs: projectDir,
      outputAbsPath: output,
      buffer: PNG_1X1,
      quality: 87,
    });

    expect(result).toMatchObject({
      output_path: output,
      format: 'jpeg',
      width: 1,
      height: 1,
      engine: 'sharp',
      model_calls: 0,
    });
    expect(fs.readFileSync(output).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(fs.readdirSync(path.dirname(output))).toEqual(['result.jpg']);
  });

  it('rejects paths and arguments before publishing an output', async () => {
    const outside = path.join(root, 'outside.png');
    await expect(writeImageAssetBuffer({
      projectDirAbs: projectDir,
      outputAbsPath: outside,
      buffer: PNG_1X1,
    })).rejects.toThrow('must stay inside the image project');
    await expect(writeImageAssetBuffer({
      projectDirAbs: projectDir,
      outputAbsPath: path.join(projectDir, 'result.gif'),
      buffer: PNG_1X1,
    })).rejects.toThrow('must end in png, jpg, jpeg, or webp');
    await expect(writeImageAssetBuffer({
      projectDirAbs: projectDir,
      outputAbsPath: path.join(projectDir, 'result.png'),
      buffer: PNG_1X1,
      quality: 0,
    })).rejects.toThrow('quality must be an integer from 1 to 100');
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.readdirSync(projectDir)).toEqual([]);
  });

  it('rejects an output routed through a project-local symlink', async () => {
    const outsideDir = path.join(root, 'outside');
    const escape = path.join(projectDir, 'escape');
    fs.mkdirSync(outsideDir);
    fs.symlinkSync(outsideDir, escape, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(writeImageAssetBuffer({
      projectDirAbs: projectDir,
      outputAbsPath: path.join(escape, 'escaped.png'),
      buffer: PNG_1X1,
    })).rejects.toThrow('must stay inside the image project');

    expect(fs.readdirSync(outsideDir)).toEqual([]);
  });

  it('never replaces an existing output and cleans its completed temporary file', async () => {
    const output = path.join(projectDir, 'result.webp');
    fs.writeFileSync(output, 'user-owned-bytes', 'utf8');

    await expect(writeImageAssetBuffer({
      projectDirAbs: projectDir,
      outputAbsPath: output,
      buffer: PNG_1X1,
    })).rejects.toThrow('E_IMAGE_ASSET_EXISTS');

    expect(fs.readFileSync(output, 'utf8')).toBe('user-owned-bytes');
    expect(fs.readdirSync(projectDir)).toEqual(['result.webp']);
  });
});
