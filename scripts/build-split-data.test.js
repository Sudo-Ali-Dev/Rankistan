import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSplitData } from './build-split-data.js';
import { BOARD_FIELDS, SPLIT_SCHEMA, developerFileName } from '../src/utils/split-data.js';

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

  it('serves data.json without the pipeline-only fields, and everything else as it was', () => {
    const shadowed = {
      ...PAYLOAD,
      leaderboard: PAYLOAD.leaderboard.map((row, i) =>
        i === 0
          ? { ...row, shadow_contributions: { v: 1, at: 'x' }, events_window: { days: 2 } }
          : row
      )
    };
    publish(shadowed);
    const result = buildSplitData({ sourcePath, outDir, log: quiet });
    const served = fs.readFileSync(path.join(outDir, 'data.json'), 'utf8');
    expect(JSON.parse(served)).toEqual(PAYLOAD);
    expect(served).not.toMatch(/shadow_contributions|events_window/);
    // Compact, like the pipeline writes it, and keyed in the same order.
    expect(served).toBe(JSON.stringify(PAYLOAD));
    expect(result.stripped).toBeGreaterThan(0);
    // The state itself is left alone.
    expect(fs.readFileSync(sourcePath, 'utf8')).toMatch(/shadow_contributions/);
  });

  it('serves a row a run missed without its miss counter', () => {
    const missed = {
      ...PAYLOAD,
      leaderboard: PAYLOAD.leaderboard.map((row, i) =>
        i === 0 ? { ...row, missed_runs: 1, missed_since: '2026-10-14T00:00:00.000Z' } : row
      )
    };
    publish(missed);
    const result = buildSplitData({ sourcePath, outDir, log: quiet });
    const served = fs.readFileSync(path.join(outDir, 'data.json'), 'utf8');
    expect(served).toBe(JSON.stringify(PAYLOAD));
    expect(result.stripped).toBeGreaterThan(0);
    const detail = fs.readFileSync(
      path.join(outDir, 'dev', developerFileName(PAYLOAD.leaderboard[0].username)),
      'utf8'
    );
    expect(detail).not.toMatch(/missed_runs|missed_since/);
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

  describe('Rank History', () => {
    const measured = {
      ...PAYLOAD,
      last_updated: '2026-10-21T12:00:00.000Z',
      leaderboard: [
        { ...PAYLOAD.leaderboard[0], github_id: 1, score_exact: 900, model_version: '3.1.0' },
        { ...PAYLOAD.leaderboard[1], github_id: 2, score_exact: 800, model_version: '3.1.0' }
      ]
    };
    const COLS = [
      'id',
      'login',
      'rank',
      'tie',
      'score',
      'work',
      'collab',
      'appr',
      'days',
      'age',
      'flags'
    ];
    function history() {
      const historyDir = path.join(dir, 'rank-history');
      fs.mkdirSync(historyDir);
      const record = {
        v: 1,
        d: '2026-10-20',
        model: '3.1.0',
        cols: COLS,
        rows: [[1, 'Ali-Dev', 2, 0, 790, 0, 0, 0, 12, 0, 0]],
        out: []
      };
      fs.writeFileSync(path.join(historyDir, 'history.ndjson'), `${JSON.stringify(record)}\n`);
      const then = {
        last_updated: '2026-10-20T12:00:00.000Z',
        model: '3.1.0',
        rows: [[1, 2, 790]]
      };
      fs.writeFileSync(path.join(historyDir, 'then.json'), JSON.stringify(then));
      return historyDir;
    }

    it("writes each developer's history, and the move under each rank", () => {
      publish(measured);
      const result = buildSplitData({ sourcePath, outDir, historyDir: history(), log: quiet });
      expect(result.histories).toBe(2);
      expect(fs.readdirSync(path.join(outDir, 'history')).sort()).toEqual([
        'ali-dev.json',
        'sara.json'
      ]);
      const ali = readJson('history', 'ali-dev.json');
      expect(ali.points.map((p) => p[0])).toEqual(['2026-10-20', '2026-10-21']);
      expect(ali.movement).toMatchObject({ kind: 'move', rank_then: 2, rank_now: 1 });
      const board = readJson('board.json');
      expect(board.leaderboard.map((r) => r.move)).toEqual([1, 'new']);
      // data.json is the pipeline's board: it carries no history at all.
      expect(readJson('data.json').leaderboard.some((r) => 'move' in r)).toBe(false);
    });

    it('writes no history and no markers when there is no history to read', () => {
      publish(measured);
      const result = buildSplitData({ sourcePath, outDir, historyDir: null, log: quiet });
      expect(result.histories).toBe(0);
      expect(fs.existsSync(path.join(outDir, 'history'))).toBe(false);
      expect(readJson('board.json').leaderboard.some((r) => 'move' in r)).toBe(false);
    });
  });

  it('rejects a source with no leaderboard', () => {
    publish({ last_updated: 'x' });
    expect(() => buildSplitData({ sourcePath, outDir, log: quiet })).toThrow(/leaderboard/);
  });
});
