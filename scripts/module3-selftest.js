'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { generateWeeklyDigest } = require('./generate-digest');

async function run() {
  const root = process.cwd();
  const dataPath = path.join(root, 'public', 'data.json');
  const digestPath = path.join(root, 'public', 'digest.json');

  const backupData = await fs.readFile(dataPath, 'utf8').catch(() => null);
  const backupDigest = await fs.readFile(digestPath, 'utf8').catch(() => null);

  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for fallback cases');
  };

  try {
    await fs.writeFile(dataPath, JSON.stringify({ leaderboard: [] }, null, 2));
    const emptyRepos = await generateWeeklyDigest({ repoRoot: root, runDate: new Date('2026-03-22T00:00:00Z') });
    if (emptyRepos.digest_text !== 'No new repos this week.') {
      throw new Error('Empty repos fallback failed');
    }

    await fs.writeFile(
      dataPath,
      JSON.stringify({
        leaderboard: [
          {
            digest_repos: [
              {
                owner: 'dev1',
                name: 'repo1',
                description: '',
                stars: 10,
                language: null,
                url: 'https://github.com/dev1/repo1'
              }
            ]
          }
        ]
      }, null, 2)
    );

    const noDescriptions = await generateWeeklyDigest({ repoRoot: root, runDate: new Date('2026-03-22T00:00:00Z') });
    if (noDescriptions.digest_text !== 'No new repos with descriptions this week.') {
      throw new Error('No-description fallback failed');
    }

    console.log('Module 3 self-test: PASS');
  } finally {
    global.fetch = originalFetch;

    if (backupData === null) {
      await fs.unlink(dataPath).catch(() => {});
    } else {
      await fs.writeFile(dataPath, backupData, 'utf8');
    }

    if (backupDigest === null) {
      await fs.unlink(digestPath).catch(() => {});
    } else {
      await fs.writeFile(digestPath, backupDigest, 'utf8');
    }
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
