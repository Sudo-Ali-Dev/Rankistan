// Splits public/data.json into the files the browser reads, after `vite build`.
//
//   node scripts/build-split-data.js [--source public/data.json] [--out dist]
//
// Writes dist/board.json, dist/digest.json and dist/dev/<login>.json, and
// nothing outside the output directory: these are build products, derived
// from public/data.json on every deploy (deploy.yml downloads it from the
// pipeline-state release first), and never committed. The shapes live in
// src/utils/split-data.js, shared with the browser so its data.json fallback
// computes the same thing.
//
// dist/data.json is what the Worker and outside readers fetch from the site
// root. It is public/data.json with the pipeline-only fields removed from every
// row (PIPELINE_ONLY_FIELDS in split-data.js: the contributions measurement and
// the miss counter), and byte-identical to it when no row carries one. This
// checks the copy Vite made rather than trusting it, then rewrites it.
//
// Each dev/<login>.json also carries `score_evidence`, derived here from the
// row's measurement and the moderation list (src/model/evidence.js): what the
// score was computed from, item by item, so anyone can check it.
//
// With RANK_HISTORY_DIR set (deploy.yml, after scripts/history-pull.js), it also
// writes dist/history/<login>.json, each developer's Rank History, and gives
// every board row its `move` since this time yesterday
// (src/utils/rank-history-view.js). Without it the site is built with neither,
// and says so where the history would be.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  buildBoard,
  buildDeveloperFile,
  buildDigest,
  buildPublicPayload,
  developerFileName,
  hasPipelineOnlyFields
} from '../src/utils/split-data.js';
import { scoreModel } from '../src/model/score.js';
import { boardMoves, developerHistory } from '../src/utils/rank-history-view.js';
import { CONTRIBUTIONS_FIELD } from './measure/contributions.js';
import { loadModerationFile, MODERATION_PATH } from './moderation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPLIT_OUTPUTS = ['board.json', 'digest.json', 'dev', 'history'];

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
export function buildSplitData({
  sourcePath,
  outDir,
  moderation = loadModerationFile(path.join(ROOT, MODERATION_PATH)),
  historyDir = process.env.RANK_HISTORY_DIR || null,
  log = console
}) {
  const sourceBytes = fs.readFileSync(sourcePath);
  const source = JSON.parse(sourceBytes.toString('utf8'));
  if (!Array.isArray(source?.leaderboard)) {
    throw new Error(`${sourcePath} has no leaderboard array.`);
  }
  const history = readHistory(historyDir);
  // Each row's move since this time yesterday, for the marker under its rank. Rows keep their
  // objects otherwise, so the history below can find each one on the board.
  const moves = history ? boardMoves({ board: source, ...history }) : new Map();
  const payload = moves.size
    ? {
        ...source,
        leaderboard: source.leaderboard.map((row) =>
          moves.has(row.github_id) ? { ...row, move: moves.get(row.github_id) } : row
        )
      }
    : source;

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
  // Same serialisation as the pipeline's (scripts/write-leaderboard.js): compact.
  // The pipeline's board, never the marked one: data.json carries no history.
  const publicBytes = hasPipelineOnlyFields(source)
    ? Buffer.from(JSON.stringify(buildPublicPayload(source)))
    : sourceBytes;
  if (publicBytes !== sourceBytes) fs.writeFileSync(published, publicBytes);

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
  const digest = writeJson(path.join(outDir, 'digest.json'), buildDigest(source));

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
    writeJson(
      path.join(devDir, name),
      buildDeveloperFile(payload, withEvidence(rows[0], moderation))
    );
    developers += 1;
  }

  if (skipped.length > 0) {
    log.warn(
      `build-split-data: no detail file for ${skipped.length} row(s): ${skipped.join(', ')}`
    );
  }

  // Rank History: one file per developer on today's board, and none for anyone else.
  const historyOut = path.join(outDir, 'history');
  fs.rmSync(historyOut, { recursive: true, force: true });
  let histories = 0;
  if (history) {
    fs.mkdirSync(historyOut);
    for (const [name, rows] of byName) {
      if (rows.length > 1) continue;
      const file = developerHistory({ board: payload, row: rows[0], ...history });
      if (!file) continue;
      writeJson(path.join(historyOut, name), file);
      histories += 1;
    }
  }
  return {
    board,
    digest,
    developers,
    histories,
    skipped,
    published: publicBytes.length,
    stripped: sourceBytes.length - publicBytes.length
  };
}

/**
 * The daily records and the board of this time yesterday that scripts/history-pull.js left in
 * `dir`, or null when there is no such directory: then there is no Rank History to build.
 */
function readHistory(dir) {
  if (!dir || !fs.existsSync(path.join(dir, 'history.ndjson'))) return null;
  const records = fs
    .readFileSync(path.join(dir, 'history.ndjson'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  const thenPath = path.join(dir, 'then.json');
  const then = fs.existsSync(thenPath) ? JSON.parse(fs.readFileSync(thenPath, 'utf8')) : null;
  return { records, then };
}

/**
 * A row with its score's evidence, derived from its measurement: every working day and every pull
 * request, review and merge that counted. Only the developer's own file carries it. A row with no
 * measurement the model reads gets none.
 */
function withEvidence(row, moderation) {
  const block = row?.[CONTRIBUTIONS_FIELD];
  if (block == null) return row;
  try {
    return { ...row, score_evidence: scoreModel(block, { moderation }).evidence };
  } catch {
    return row;
  }
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
        `${result.developers} developer files, ${result.histories} history files, ` +
        `data.json ${kb(result.published)}` +
        (result.stripped > 0 ? ` (${kb(result.stripped)} of pipeline-only fields left out)` : '')
    );
  } catch (error) {
    console.error(`build-split-data: ${error.message}`);
    process.exit(1);
  }
}
