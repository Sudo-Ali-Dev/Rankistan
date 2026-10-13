// Splits public/data.json into the files the browser reads, after `vite build`.
//
//   node scripts/build-split-data.js [--source public/data.json] [--out dist]
//
// Writes dist/board.json, dist/digest.json and dist/dev/<login>.json, and
// nothing outside the output directory: these are build products, derived
// from the committed data.json on every deploy, and never committed
// themselves. The shapes live in src/utils/split-data.js, shared with the
// browser so its data.json fallback computes the same thing.
//
// dist/data.json must stay byte-identical to the committed file - the Worker
// and outside readers fetch it from the site root - so this checks the copy
// Vite made rather than trusting it.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  buildBoard,
  buildDeveloperFile,
  buildDigest,
  developerFileName
} from '../src/utils/split-data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPLIT_OUTPUTS = ['board.json', 'digest.json', 'dev'];

function writeJson(file, value) {
  const text = JSON.stringify(value);
  fs.writeFileSync(file, text);
  return Buffer.byteLength(text);
}

/**
 * @returns {{ board: number, digest: number, developers: number, skipped: string[] }}
 *   byte sizes of board.json and digest.json, the number of developer files,
 *   and the logins that got no file (they fall back to data.json in the browser).
 */
export function buildSplitData({ sourcePath, outDir, log = console }) {
  const sourceBytes = fs.readFileSync(sourcePath);
  const payload = JSON.parse(sourceBytes.toString('utf8'));
  if (!Array.isArray(payload?.leaderboard)) {
    throw new Error(`${sourcePath} has no leaderboard array.`);
  }

  const published = path.join(outDir, 'data.json');
  if (!fs.existsSync(published)) {
    throw new Error(`${published} is missing - run \`vite build\` first.`);
  }
  if (!fs.readFileSync(published).equals(sourceBytes)) {
    throw new Error(
      `${published} differs from ${sourcePath}. The Worker reads it from the site root, ` +
        'so it must be published unchanged.'
    );
  }

  // Vite copies public/ into the output first, so a committed file at one of
  // these paths - scripts/generate-digest.js writes public/digest.json - would
  // be overwritten here without a word. Refuse instead.
  const publicDir = path.dirname(sourcePath);
  for (const name of SPLIT_OUTPUTS) {
    if (fs.existsSync(path.join(publicDir, name))) {
      throw new Error(
        `${path.join(publicDir, name)} exists, and the split build writes ${name} - rename one.`
      );
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const board = writeJson(path.join(outDir, 'board.json'), buildBoard(payload));
  const digest = writeJson(path.join(outDir, 'digest.json'), buildDigest(payload));

  // Rebuilt from scratch, so a developer who left the board leaves no file.
  const devDir = path.join(outDir, 'dev');
  fs.rmSync(devDir, { recursive: true, force: true });
  fs.mkdirSync(devDir);

  // Two logins that differ only in case would share a file. GitHub logins are
  // case-insensitively unique, so that is a pipeline bug: write neither, and
  // let both fall back to data.json rather than serve one as the other.
  const byName = new Map();
  const skipped = [];
  for (const row of payload.leaderboard) {
    const name = developerFileName(row?.username);
    if (!name) {
      skipped.push(String(row?.username ?? ''));
      continue;
    }
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(row);
  }

  let developers = 0;
  for (const [name, rows] of byName) {
    if (rows.length > 1) {
      skipped.push(...rows.map((row) => row.username));
      continue;
    }
    writeJson(path.join(devDir, name), buildDeveloperFile(payload, rows[0]));
    developers += 1;
  }

  if (skipped.length > 0) {
    log.warn(
      `build-split-data: no detail file for ${skipped.length} row(s): ${skipped.join(', ')}`
    );
  }
  return { board, digest, developers, skipped };
}

function gzipSize(file) {
  // The default level, which is what `gzip -c` and most servers use.
  return zlib.gzipSync(fs.readFileSync(file)).length;
}

function argValue(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const sourcePath = path.resolve(ROOT, argValue(argv, '--source', 'public/data.json'));
  const outDir = path.resolve(ROOT, argValue(argv, '--out', 'dist'));

  try {
    const result = buildSplitData({ sourcePath, outDir });
    const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
    console.log(
      `build-split-data: board.json ${kb(result.board)} (${kb(gzipSize(path.join(outDir, 'board.json')))} gzip), ` +
        `digest.json ${kb(result.digest)} (${kb(gzipSize(path.join(outDir, 'digest.json')))} gzip), ` +
        `${result.developers} developer files`
    );
  } catch (error) {
    console.error(`build-split-data: ${error.message}`);
    process.exit(1);
  }
}
