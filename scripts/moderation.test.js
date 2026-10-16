import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { MODERATION_PATH, loadModerationFile, validateModeration } from './moderation.js';

const entry = {
  repo: 'ana/testrepo',
  reason: 'A script commits "automated update" every ten minutes.',
  evidence: 'https://github.com/ana/testrepo/commits',
  added: '2026-10-17'
};

describe('the moderation list', () => {
  it('ships valid, and the pipeline and the Worker read the same file', () => {
    expect(Array.isArray(loadModerationFile(MODERATION_PATH))).toBe(true);
  });

  it('needs a reason a reader can understand and evidence they can open', () => {
    expect(validateModeration({ repositories: [entry] })).toEqual([entry]);
    expect(() => validateModeration({ repositories: [{ ...entry, reason: 'bad' }] })).toThrow(
      /reason/
    );
    expect(() =>
      validateModeration({ repositories: [{ ...entry, evidence: 'trust me' }] })
    ).toThrow(/evidence/);
    expect(() => validateModeration({ repositories: [{ ...entry, repo: 'nope' }] })).toThrow(
      /repo/
    );
    expect(() =>
      validateModeration({ repositories: [entry, { ...entry, repo: 'ANA/testrepo' }] })
    ).toThrow(/twice/);
    expect(() => validateModeration({})).toThrow(/repositories/);
  });

  it('treats a missing file as an empty list and a malformed one as an error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rankistan-moderation-'));
    expect(loadModerationFile(path.join(dir, 'none.json'))).toEqual([]);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{');
    expect(() => loadModerationFile(path.join(dir, 'bad.json'))).toThrow();
  });
});
