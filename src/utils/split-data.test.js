import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  BOARD_FIELDS,
  DETAIL_ONLY_FIELDS,
  PIPELINE_ONLY_FIELDS,
  PIPELINE_ONLY_TOP_FIELDS,
  SPLIT_SCHEMA,
  buildBoard,
  buildDeveloperFile,
  buildPublicPayload,
  buildDigest,
  developerFileName,
  hasPipelineOnlyFields,
  developerFilePath,
  isBoardPayload,
  isDeveloperFileFor,
  isDigestPayload,
  summarizeDigest,
  toBoardRow,
  DERIVED_BOARD_FIELDS,
  toDeveloperRow
} from './split-data';
import { ensureLeaderboardTags } from './tags';

const REAL = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public', 'data.json'), 'utf8'));

// Digest.jsx's useMemo before the computation moved into split-data.js,
// verbatim, so the precomputed digest is pinned to what the page computed.
function legacyDigest(leaderboard) {
  const devs = Array.isArray(leaderboard) ? leaderboard : [];
  const repos = devs.flatMap((d) =>
    (d.digest_repos || []).map((r) => ({
      ...r,
      stars: r.stars || 0,
      dev: d.username,
      devAvatar: d.avatar_url
    }))
  );
  repos.sort((a, b) => b.stars - a.stars);

  const contribMap = new Map();
  for (const r of repos) {
    if (!contribMap.has(r.dev)) {
      contribMap.set(r.dev, {
        username: r.dev,
        avatar: r.devAvatar,
        repoCount: 0,
        totalStars: 0
      });
    }
    const entry = contribMap.get(r.dev);
    entry.repoCount += 1;
    entry.totalStars += r.stars;
  }
  const contributors = Array.from(contribMap.values()).sort((a, b) => b.totalStars - a.totalStars);

  return {
    topRepos: repos.slice(0, 100),
    topContributors: contributors.slice(0, 10),
    totalRepos: repos.length,
    devsWithRepos: devs.filter((d) => d.digest_repos?.length > 0).length
  };
}

// The two fields the page computed and never rendered.
function withoutUnrenderedFields(digest) {
  return {
    ...digest,
    topRepos: digest.topRepos.map(({ devAvatar: _devAvatar, ...rest }) => rest),
    topContributors: digest.topContributors.map(({ avatar: _avatar, ...rest }) => rest)
  };
}

describe('buildBoard', () => {
  const board = buildBoard(REAL);

  it('carries every row, in order, with only the list fields', () => {
    expect(board.leaderboard).toHaveLength(REAL.leaderboard.length);
    board.leaderboard.forEach((row, i) => {
      expect(row.username).toBe(REAL.leaderboard[i].username);
      for (const key of Object.keys(row)) {
        expect([...BOARD_FIELDS, ...DERIVED_BOARD_FIELDS]).toContain(key);
      }
    });
  });

  it('leaves out what only the expanded card and the Digest read', () => {
    for (const row of board.leaderboard) {
      for (const field of ['bio', 'top_repos', 'digest_repos', 'linkedin_url']) {
        expect(row).not.toHaveProperty(field);
      }
    }
  });

  it('keeps every value it carries exactly as published', () => {
    REAL.leaderboard.forEach((source, i) => {
      for (const field of BOARD_FIELDS.filter((f) => f !== 'tags' && f in source)) {
        expect(board.leaderboard[i][field]).toEqual(source[field]);
      }
    });
  });

  it('carries the CSV export and compare columns', () => {
    // Leaderboard.jsx CSV_EXPORT_COLUMNS and CompareModal.jsx COMPARE_ROWS.
    const csv = ['rank', 'username', 'name', 'location', 'score', 'followers'];
    const more = ['public_repos', 'events_30d', 'total_stars', 'top_languages', 'tags'];
    for (const column of [...csv, ...more, 'avatar_url']) expect(BOARD_FIELDS).toContain(column);
  });

  it('computes tags the browser could no longer match from a board row', () => {
    // A row published without tags is matched against its bio and repository
    // text - none of which the board carries.
    const untagged = {
      ...REAL,
      leaderboard: REAL.leaderboard.map((row, i) => (i === 0 ? { ...row, tags: [] } : row))
    };
    const expected = ensureLeaderboardTags(untagged.leaderboard).map((row) => row.tags);
    expect(buildBoard(untagged).leaderboard.map((row) => row.tags)).toEqual(expected);
  });

  it('carries the file metadata and a schema version, and never the source rows', () => {
    expect(board.schema).toBe(SPLIT_SCHEMA);
    expect(board.last_updated).toBe(REAL.last_updated);
    expect(board.total_devs).toBe(REAL.total_devs);
    expect(isBoardPayload(board)).toBe(true);
    expect(buildBoard({ ...REAL, model_version: 'v3' }).model_version).toBe('v3');
    expect(buildBoard({ ...REAL, schema: 99 }).schema).toBe(SPLIT_SCHEMA);
  });

  it('skips a list field a row does not have rather than inventing one', () => {
    expect(toBoardRow({ username: 'a', bio: 'x' })).toEqual({ username: 'a' });
  });

  it('carries the score to two decimals, the precision changes of rank show at', () => {
    expect(toBoardRow({ username: 'a', score: 500, score_exact: 499.71986 }).score_shown).toBe(
      499.72
    );
    expect(toBoardRow({ username: 'a', score: 500, score_exact: 500 }).score_shown).toBe(500);
    expect(toBoardRow({ username: 'a', score: 3 })).not.toHaveProperty('score_shown');
  });
});

describe('summarizeDigest', () => {
  it('matches what Digest.jsx computed, on the real data.json', () => {
    const { activeDevs, ...summary } = summarizeDigest(REAL.leaderboard);
    expect(summary).toEqual(withoutUnrenderedFields(legacyDigest(REAL.leaderboard)));
    expect(activeDevs).toBe(REAL.leaderboard.length);
  });

  it('keeps leaderboard order between repositories with equal stars', () => {
    const rows = [
      { username: 'a', digest_repos: [{ owner: 'a', name: 'one', stars: 5 }] },
      { username: 'b', digest_repos: [{ owner: 'b', name: 'two', stars: 5 }] }
    ];
    expect(summarizeDigest(rows).topRepos.map((r) => r.name)).toEqual(['one', 'two']);
    expect(summarizeDigest(rows)).toEqual({
      ...withoutUnrenderedFields(legacyDigest(rows)),
      activeDevs: 2
    });
  });

  it('counts a repository with no star count as zero stars', () => {
    const rows = [{ username: 'a', digest_repos: [{ owner: 'a', name: 'x' }] }];
    expect(summarizeDigest(rows).topRepos[0].stars).toBe(0);
  });
});

describe('buildDigest', () => {
  it('survives a JSON round trip unchanged, which is how the page receives it', () => {
    const digest = buildDigest(REAL);
    expect(JSON.parse(JSON.stringify(digest))).toEqual(digest);
    expect(digest.schema).toBe(SPLIT_SCHEMA);
    expect(digest.last_updated).toBe(REAL.last_updated);
    expect(isDigestPayload(digest)).toBe(true);
  });
});

describe('buildDeveloperFile', () => {
  it('carries the row as the browser is given it, with its schema and date', () => {
    const row = REAL.leaderboard[0];
    const file = buildDeveloperFile(REAL, row);
    expect(file).toEqual({
      schema: SPLIT_SCHEMA,
      last_updated: REAL.last_updated,
      developer: toDeveloperRow(row)
    });
    expect(file.developer).not.toHaveProperty('contributions');
    expect(isDeveloperFileFor(file, row.username.toUpperCase())).toBe(true);
    expect(isDeveloperFileFor(file, 'someone-else')).toBe(false);
  });
});

describe('pipeline-only fields', () => {
  const measured = {
    ...REAL,
    leaderboard: REAL.leaderboard.map((row) => ({
      ...row,
      contributions: { v: 2, at: '2026-10-14T00:00:00Z' },
      shadow_contributions: { v: 1, at: '2026-10-13T00:00:00Z', cal60: [1, 2, 3] },
      events_window: { fetched: 200, truncated: true, days: 6.1 },
      missed_runs: 1,
      missed_since: '2026-10-14T00:00:00.000Z'
    }))
  };

  it('are named, and none is a board field', () => {
    expect(PIPELINE_ONLY_FIELDS).toEqual([
      'contributions',
      'shadow_contributions',
      'events_window',
      'missed_runs',
      'missed_since'
    ]);
    expect(DETAIL_ONLY_FIELDS).toEqual(['score_evidence']);
    for (const field of DETAIL_ONLY_FIELDS) expect(BOARD_FIELDS).not.toContain(field);
    for (const field of PIPELINE_ONLY_FIELDS) expect(BOARD_FIELDS).not.toContain(field);
  });

  it('reach no file the browser reads, which stay byte for byte what they were', () => {
    expect(JSON.stringify(buildBoard(measured))).toBe(JSON.stringify(buildBoard(REAL)));
    expect(JSON.stringify(buildDigest(measured))).toBe(JSON.stringify(buildDigest(REAL)));
    measured.leaderboard.forEach((row, i) => {
      expect(JSON.stringify(buildDeveloperFile(measured, row))).toBe(
        JSON.stringify(buildDeveloperFile(REAL, REAL.leaderboard[i]))
      );
    });
  });
});

describe('pipeline-only top-level fields', () => {
  it('keep who left the board, and why, out of every file the browser or the Worker reads', () => {
    expect(PIPELINE_ONLY_TOP_FIELDS).toEqual(['departures', 'history_through', 'history_scrubbed']);
    const state = {
      ...REAL,
      departures: [{ at: '2026-10-17T03:00:00.000Z', id: 7, reason: 'displaced' }],
      history_through: '2026-10-16'
    };
    expect(hasPipelineOnlyFields(state)).toBe(true);
    const bare = { last_updated: REAL.last_updated, leaderboard: [] };
    expect(hasPipelineOnlyFields(bare)).toBe(false);
    expect(hasPipelineOnlyFields({ ...bare, history_through: '2026-10-16' })).toBe(true);
    const served = buildPublicPayload(state);
    expect(served).not.toHaveProperty('departures');
    expect(served).not.toHaveProperty('history_through');
    expect(JSON.stringify(buildBoard(state))).toBe(JSON.stringify(buildBoard(REAL)));
  });
});

describe('detail-only fields', () => {
  it("reach a developer's own file and nothing else", () => {
    const evidence = { working_days: ['2026-10-01'] };
    const withEvidence = {
      ...REAL,
      leaderboard: REAL.leaderboard.map((row) => ({ ...row, score_evidence: evidence }))
    };
    expect(
      buildDeveloperFile(withEvidence, withEvidence.leaderboard[0]).developer.score_evidence
    ).toEqual(evidence);
    expect(JSON.stringify(buildBoard(withEvidence))).not.toContain('score_evidence');
    expect(JSON.stringify(buildPublicPayload(withEvidence))).not.toContain('score_evidence');
  });
});

describe('developerFileName', () => {
  it('is the lowercased login for every real login', () => {
    for (const { username } of REAL.leaderboard) {
      expect(developerFileName(username)).toBe(`${username.toLowerCase()}.json`);
    }
  });

  it('gives each real login its own file', () => {
    const names = REAL.leaderboard.map((row) => developerFileName(row.username));
    expect(new Set(names).size).toBe(names.length);
  });

  it('escapes anything that could leave the directory or need URL encoding', () => {
    for (const login of ['../etc/passwd', 'a/b', 'a\\b', '.', '..', 'a%2Fb', 'a?b#c', 'ä', 'a b']) {
      const name = developerFileName(login);
      expect(name).toMatch(/^[a-z0-9_-]+\.json$/);
      expect(encodeURIComponent(name)).toBe(name);
    }
    expect(developerFileName('../x')).toBe('_2e_2e_2fx.json');
  });

  it('never maps two different logins to one name', () => {
    // `_` is always escaped, so an escape cannot be forged by a literal login.
    expect(developerFileName('a_2fb')).not.toBe(developerFileName('a/b'));
    expect(developerFileName('a_2fb')).toBe('a_5f2fb.json');
  });

  it('has no file for an empty or absurdly long login', () => {
    expect(developerFileName('')).toBeNull();
    expect(developerFileName('   ')).toBeNull();
    expect(developerFileName(null)).toBeNull();
    expect(developerFileName('x'.repeat(201))).toBeNull();
    expect(developerFilePath('')).toBeNull();
    expect(developerFilePath('Ali-Dev')).toBe('dev/ali-dev.json');
  });
});

describe('payload checks', () => {
  it('reject a file from another schema, which falls back to data.json', () => {
    expect(isBoardPayload({ schema: SPLIT_SCHEMA + 1, leaderboard: [] })).toBe(false);
    expect(isBoardPayload({ leaderboard: [] })).toBe(false);
    expect(isDigestPayload({ schema: SPLIT_SCHEMA, topRepos: [] })).toBe(false);
    expect(isDeveloperFileFor({ schema: SPLIT_SCHEMA, developer: {} }, 'a')).toBe(false);
  });
});
