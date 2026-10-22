import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import type { ExpoConfig } from 'expo/config';
import makeConfig from '../../app.config';
import {
  LAUNCH_SCALE,
  NATIVE_SPLASH_MARK_WIDTH_DP,
  SPLASH_CANVAS_PX,
  SPLASH_IMAGE_WIDTH_DP,
  SPLASH_MARK_PX,
} from './launchMetrics';
import { markSize } from './swapTimelines';

const config: ExpoConfig = makeConfig({ config: {} as ExpoConfig, projectRoot: '', staticConfigPath: null, packageJsonPath: null });

/**
 * The width in pixels of the opaque part of an 8-bit RGBA, non-interlaced PNG (what splash-icon.png is). A small decoder on
 * node:zlib, so the test needs no image library: it unfilters each scanline and looks at the alpha byte.
 */
function opaqueWidth(buffer: Buffer): { canvas: number; opaque: number } {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  const parts: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'bit depth 8');
      assert.equal(data[9], 6, 'colour type RGBA');
      assert.equal(data[12], 0, 'not interlaced');
    } else if (type === 'IDAT') parts.push(data);
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * 4;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      const left = x >= 4 ? (rows[y * stride + x - 4] ?? 0) : 0;
      const up = y > 0 ? (rows[(y - 1) * stride + x] ?? 0) : 0;
      const upLeft = x >= 4 && y > 0 ? (rows[(y - 1) * stride + x - 4] ?? 0) : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      rows[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  let minX = width;
  let maxX = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((rows[y * stride + x * 4 + 3] ?? 0) > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  return { canvas: width, opaque: maxX - minX + 1 };
}

test('the launch animation starts at the size of the native splash mark: imageWidth and the PNG are what the constants say', () => {
  const splash = (config.plugins ?? []).find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen') as
    | [string, { imageWidth: number; image: string }]
    | undefined;
  assert.ok(splash, 'the expo-splash-screen plugin is configured');
  assert.equal(splash[1].imageWidth, SPLASH_IMAGE_WIDTH_DP);

  const measured = opaqueWidth(fs.readFileSync(path.join(__dirname, '../..', splash[1].image)));
  assert.equal(measured.canvas, SPLASH_CANVAS_PX);
  assert.equal(measured.opaque, SPLASH_MARK_PX, 'the opaque mark in splash-icon.png is the width the constant says');
});

test('the scaled launch mark is as wide as the native one, with the Figma proportions (3:2)', () => {
  const size = markSize(LAUNCH_SCALE);
  assert.ok(Math.abs(size.width - NATIVE_SPLASH_MARK_WIDTH_DP) < 1e-9);
  assert.ok(Math.abs(size.width / size.height - 1.5) < 1e-9);
  assert.ok(Math.abs(NATIVE_SPLASH_MARK_WIDTH_DP - 98.4375) < 1e-9);
});
