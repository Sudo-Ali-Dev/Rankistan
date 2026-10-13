import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSplitData } from './build-split-data.js';
import { BOARD_FIELDS, SPLIT_SCHEMA } from '../src/utils/split-data.js';

const PAYLOAD = {
  last_updated: '2026-10-13T12:30:32.193Z',
  total_devs: 2,
  leaderboard: [
    {
      rank: 1,
      username: 'Ali-Dev',
      name: 'Ali',
      bio: 'Builds compilers.',
      score: 900,
      tags: ['Systems'],
      top_repos: [{ name: 'cc', description: 'A compiler', stars: 3, url: 'u' }],
      digest_repos: [{ owner: 'Ali-Dev', name: 'cc', stars: 3 }]
    },
    { rank: 2, username: 'sara', score: 800, tags: [], digest_repos: [] }
  ]
};

let dir;
let outDir;
let sourcePath;
const quiet = { warn: vi.fn() };

function publish(payload = PAYLOAD) {
  const text = JSON.stringify(payload, null, 2);
  fs.writeFileSync(sourcePath, text);
  fs.writeFileSync(path.join(outDir, 'data.json'), text);
}

const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(outDir, ...parts), 'utf8'));

describe('buildSplitData', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-data-'));
    outDir = path.join(dir, 'dist');
    fs.mkdirSync(outDir);
    sourcePath = path.join(dir, 'data.json');
    quiet.warn.mockClear();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes the board, the digest and one file per developer', () => {
    publish();
    const result = buildSplitData({ sourcePath, outDir, log: quiet });

    expect(result.developers).toBe(2);
    expect(fs.readdirSync(path.join(outDir, 'dev')).sort()).toEqual(['ali-dev.json', 'sara.json']);

    const board = readJson('board.json');
    expect(board.schema).toBe(SPLIT_SCHEMA);
    expect(board.last_updated).toBe(PAYLOAD.last_updated);
    expect(board.total_devs).toBe(2);
    for (const row of board.leaderboard) {
      for (const key of Object.keys(row)) expect(BOARD_FIELDS).toContain(key);
    }

    expect(readJson('dev', 'ali-dev.json').developer).toEqual(PAYLOAD.leaderboard[0]);
    expect(readJson('digest.json').topRepos.map((r) => r.name)).toEqual(['cc']);
  });

  it('writes compact JSON, since every byte is downloaded', () => {
    publish();
    buildSplitData({ sourcePath, outDir, log: quiet });
    expect(fs.readFileSync(path.join(outDir, 'board.json'), 'utf8')).not.toMatch(/\n/);
  });

  it('leaves the published data.json byte-identical', () => {
    publish();
    const before = fs.readFileSync(path.join(outDir, 'data.json'));
    buildSplitData({ sourcePath, outDir, log: quiet });
    expect(fs.readFileSync(path.join(outDir, 'data.json')).equals(before)).toBe(true);
  });

  it('writes nothing outside the output directory', () => {
    publish();
    const beside = fs.readdirSync(dir).sort();
    buildSplitData({ sourcePath, outDir, log: quiet });
    expect(fs.readdirSync(dir).sort()).toEqual(beside);
  });

  it('refuses to run when the published data.json is missing or differs', () => {
    publish();
    fs.writeFileSync(path.join(outDir, 'data.json'), '{}');
    expect(() => buildSplitData({ sourcePath, outDir, log: quiet })).toThrow(/differs/);
    fs.rmSync(path.join(outDir, 'data.json'));
    expect(() => buildSplitData({ sourcePath, outDir, log: quiet })).toThrow(/missing/);
  });

  it('removes the file of a developer who has left the board', () => {
    publish();
    buildSplitData({ sourcePath, outDir, log: quiet });
    publish({ ...PAYLOAD, leaderboard: [PAYLOAD.leaderboard[1]] });
    buildSplitData({ sourcePath, outDir, log: quiet });
    expect(fs.readdirSync(path.join(outDir, 'dev'))).toEqual(['sara.json']);
  });

  it('gives no file to logins that would collide, and says so', () => {
    // Case-insensitively unique on GitHub, so this is a pipeline bug; both
    // rows fall back to data.json rather than one being served as the other.
    publish({
      ...PAYLOAD,
      leaderboard: [...PAYLOAD.leaderboard, { rank: 3, username: 'ALI-dev', score: 1 }, { rank: 4 }]
    });
    const result = buildSplitData({ sourcePath, outDir, log: quiet });
    expect(fs.readdirSync(path.join(outDir, 'dev'))).toEqual(['sara.json']);
    expect(result.skipped).toEqual(['', 'Ali-Dev', 'ALI-dev']);
    expect(quiet.warn).toHaveBeenCalledTimes(1);
  });

  it('keeps an unusual login inside dev/', () => {
    publish({ ...PAYLOAD, leaderboard: [{ rank: 1, username: '../../escape', score: 1 }] });
    buildSplitData({ sourcePath, outDir, log: quiet });
    expect(fs.readdirSync(path.join(outDir, 'dev'))).toEqual(['_2e_2e_2f_2e_2e_2fescape.json']);
    expect(fs.readdirSync(dir).sort()).toEqual(['data.json', 'dist']);
  });

  it('refuses to overwrite a file public/ already publishes at the same path', () => {
    // scripts/generate-digest.js writes public/digest.json; Vite would copy it
    // into dist/ and this build would replace it silently.
    publish();
    fs.writeFileSync(path.join(dir, 'digest.json'), '{}');
    expect(() => buildSplitData({ sourcePath, outDir, log: quiet })).toThrow(/digest\.json exists/);
    expect(fs.existsSync(path.join(outDir, 'board.json'))).toBe(false);
  });

  it('rejects a source with no leaderboard', () => {
    publish({ last_updated: 'x' });
    expect(() => buildSplitData({ sourcePath, outDir, log: quiet })).toThrow(/leaderboard/);
  });
});
