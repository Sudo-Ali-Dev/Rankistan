'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  generateWeeklyDigest,
  flattenDigestRepos,
  dedupeReposByOwnerName,
  filterAndCapRepos,
  formatWeekOf,
  validateDigestText
} = require('./generate-digest');

function createMockDigestText() {
  return [
    'This week, Pakistani developers shipped practical tools across AI, web, and automation.',
    'Several repositories focused on model serving, data workflows, and deployment quality.',
    'The momentum indicates sustained open source activity and improved project maturity.'
  ].join(' ');
}

async function createTempRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pakdev-module3-'));
  const publicDir = path.join(root, 'public');
  await fs.mkdir(publicDir, { recursive: true });
  return { root, publicDir };
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(error.stack || error.message);
    throw error;
  }
}

async function testHelperFunctions() {
  const flattened = flattenDigestRepos({
    leaderboard: [
      { digest_repos: [{ owner: 'a', name: 'r1', description: 'x' }] },
      { digest_repos: null },
      {}
    ]
  });
  assert.equal(flattened.length, 1);

  const deduped = dedupeReposByOwnerName([
    { owner: 'dev', name: 'repo', stars: 2, description: 'low' },
    { owner: 'DEV', name: 'repo', stars: 7, description: 'high' },
    { owner: 'other', name: 'repo', stars: 3, description: 'other' }
  ]);
  assert.equal(deduped.length, 2);
  const kept = deduped.find((repo) => repo.owner.toLowerCase() === 'dev');
  assert.equal(kept.stars, 7);

  const manyRepos = [];
  for (let i = 0; i < 45; i += 1) {
    manyRepos.push({
      owner: `dev${i}`,
      name: `repo${i}`,
      description: i % 2 === 0 ? `desc-${i}` : ' ',
      language: i % 3 === 0 ? null : 'JavaScript',
      stars: i,
      url: `https://example.com/${i}`
    });
  }

  const filtered = filterAndCapRepos(manyRepos);
  assert.ok(filtered.length <= 40);
  assert.ok(filtered.every((repo) => repo.description.length > 0));
  assert.ok(filtered.every((repo) => repo.language));
  for (let i = 1; i < filtered.length; i += 1) {
    assert.ok(filtered[i - 1].stars >= filtered[i].stars);
  }

  assert.equal(formatWeekOf(new Date('2026-03-22T00:00:00Z')), 'March 16 - March 22, 2026');

  assert.throws(() => validateDigestText(''), /empty/i);
  assert.throws(() => validateDigestText('too short'), /too short/i);
  assert.throws(() => validateDigestText("I'm sorry, I can't do that in this format."), /refusal/i);
  assert.equal(validateDigestText(createMockDigestText()), createMockDigestText());
}

async function testNoReposFallback() {
  const { root } = await createTempRepo();
  await writeJson(path.join(root, 'public', 'data.json'), { leaderboard: [] });

  const output = await generateWeeklyDigest({
    repoRoot: root,
    runDate: new Date('2026-03-22T00:00:00Z')
  });

  assert.equal(output.digest_text, 'No new repos this week.');
  const saved = await readJson(path.join(root, 'public', 'digest.json'));
  assert.equal(saved.digest_text, 'No new repos this week.');
  assert.deepEqual(saved.repos, []);
}

async function testNoDescriptionsFallback() {
  const { root } = await createTempRepo();
  await writeJson(path.join(root, 'public', 'data.json'), {
    leaderboard: [
      {
        digest_repos: [
          { owner: 'dev', name: 'repo', description: '', stars: 2, language: null, url: 'x' }
        ]
      }
    ]
  });

  const output = await generateWeeklyDigest({
    repoRoot: root,
    runDate: new Date('2026-03-22T00:00:00Z')
  });

  assert.equal(output.digest_text, 'No new repos with descriptions this week.');
  const saved = await readJson(path.join(root, 'public', 'digest.json'));
  assert.equal(saved.digest_text, 'No new repos with descriptions this week.');
  assert.deepEqual(saved.repos, []);
}

async function testSuccessPathWithGroq() {
  const { root } = await createTempRepo();
  await writeJson(path.join(root, 'public', 'data.json'), {
    leaderboard: [
      {
        digest_repos: [
          { owner: 'dev1', name: 'repo1', description: 'A useful project', stars: 10, language: null, url: 'u1' },
          { owner: 'dev1', name: 'repo1', description: 'duplicate lower stars', stars: 2, language: 'JS', url: 'u2' },
          { owner: 'dev2', name: 'repo2', description: 'Another useful project', stars: 20, language: 'Python', url: 'u3' }
        ]
      }
    ]
  });

  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: createMockDigestText() } }]
      })
    };
  };

  try {
    const output = await generateWeeklyDigest({
      repoRoot: root,
      groqApiKey: 'test-key',
      runDate: new Date('2026-03-22T00:00:00Z')
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, 'llama-3.3-70b-versatile');
    assert.equal(body.max_tokens, 600);
    assert.equal(body.temperature, 0.7);

    assert.equal(output.repos.length, 2);
    assert.equal(output.repos[0].stars, 20);
    assert.equal(output.repos[1].language, 'Unknown');

    const digestPath = path.join(root, 'public', 'digest.json');
    const saved = await readJson(digestPath);
    assert.equal(saved.digest_text, createMockDigestText());
    await assert.rejects(fs.access(`${digestPath}.tmp`));
  } finally {
    global.fetch = originalFetch;
  }
}

async function testNoOverwriteWhenKeyMissing() {
  const { root } = await createTempRepo();
  const digestPath = path.join(root, 'public', 'digest.json');

  await writeJson(path.join(root, 'public', 'data.json'), {
    leaderboard: [
      { digest_repos: [{ owner: 'dev', name: 'repo', description: 'desc', stars: 3, language: 'JS', url: 'u' }] }
    ]
  });
  await writeJson(digestPath, {
    week_of: 'old',
    generated_at: 'old',
    digest_text: 'KEEP_ME',
    repos: []
  });

  const previous = process.env.GROQ_API_KEY;
  const previousAlt = process.env.GROQ_API_KEY_PakDevIndex;
  delete process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY_PakDevIndex;

  try {
    await assert.rejects(
      generateWeeklyDigest({ repoRoot: root, runDate: new Date('2026-03-22T00:00:00Z') }),
      /Missing GROQ_API_KEY/i
    );

    const saved = await readJson(digestPath);
    assert.equal(saved.digest_text, 'KEEP_ME');
  } finally {
    if (previous === undefined) {
      delete process.env.GROQ_API_KEY;
    } else {
      process.env.GROQ_API_KEY = previous;
    }

    if (previousAlt === undefined) {
      delete process.env.GROQ_API_KEY_PakDevIndex;
    } else {
      process.env.GROQ_API_KEY_PakDevIndex = previousAlt;
    }
  }
}

async function testRetryAndNoOverwriteOnGroqFailure() {
  const { root } = await createTempRepo();
  const digestPath = path.join(root, 'public', 'digest.json');
  await writeJson(path.join(root, 'public', 'data.json'), {
    leaderboard: [
      { digest_repos: [{ owner: 'dev', name: 'repo', description: 'desc', stars: 3, language: 'JS', url: 'u' }] }
    ]
  });
  await writeJson(digestPath, {
    week_of: 'old',
    generated_at: 'old',
    digest_text: 'KEEP_ON_FAILURE',
    repos: []
  });

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error('network down');
  };

  try {
    await assert.rejects(
      generateWeeklyDigest({ repoRoot: root, groqApiKey: 'test-key', runDate: new Date('2026-03-22T00:00:00Z') }),
      /network down/i
    );

    assert.equal(fetchCalls, 2);
    const saved = await readJson(digestPath);
    assert.equal(saved.digest_text, 'KEEP_ON_FAILURE');
  } finally {
    global.fetch = originalFetch;
  }
}

async function main() {
  await runTest('helper functions and validation', testHelperFunctions);
  await runTest('fallback when all digest repos are empty', testNoReposFallback);
  await runTest('fallback when all descriptions are empty', testNoDescriptionsFallback);
  await runTest('successful Groq generation path', testSuccessPathWithGroq);
  await runTest('do not overwrite digest when key is missing', testNoOverwriteWhenKeyMissing);
  await runTest('retry once and keep old digest on Groq failure', testRetryAndNoOverwriteOnGroqFailure);
  console.log('Module 3 aggressive test suite: PASS');
}

main().catch((error) => {
  console.error('Module 3 aggressive test suite: FAIL');
  console.error(error.message);
  process.exit(1);
});