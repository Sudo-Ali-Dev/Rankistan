import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STRIP_FIELDS = new Set([
  'total_contributions_60d',
  'longest_gap_days',
  'raw_events_60d',
  'repos_active_7d',
  'following',
  'age_penalty_applied',
  'event_counts_30d'
]);

const OUTPUT_FIELDS = [
  'rank',
  'username',
  'name',
  'avatar_url',
  'bio',
  'location',
  'pronouns',
  'followers',
  'public_repos',
  'created_at',
  'events_30d',
  'digest_repos',
  'total_stars',
  'top_repos',
  'top_languages',
  'linkedin_url',
  'tags',
  'score',
  'batch_index'
];

export function hasValidRankAndScore(entry) {
  const rank = Number(entry?.rank);
  const score = Number(entry?.score);

  return Number.isFinite(rank) && rank > 0 && Number.isFinite(score);
}

export function validateInput(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('Module 4 aborted: input must be an array.');
  }

  if (entries.length === 0) {
    console.warn('Module 4 warning: 0 developers passed filters. Writing empty leaderboard.');
    return;
  }

  const hasAtLeastOneValid = entries.some(hasValidRankAndScore);
  if (!hasAtLeastOneValid) {
    console.warn('Module 4 warning: no entries with valid rank/score. Writing empty leaderboard.');
  }
}

export function stripInternalFields(entry) {
  const normalized = {
    ...entry,
    digest_repos: Array.isArray(entry?.digest_repos) ? entry.digest_repos : [],
    top_repos: Array.isArray(entry?.top_repos) ? entry.top_repos : [],
    top_languages: Array.isArray(entry?.top_languages) ? entry.top_languages : [],
    linkedin_url: typeof entry?.linkedin_url === 'string' ? entry.linkedin_url : ''
  };

  for (const field of STRIP_FIELDS) {
    delete normalized[field];
  }

  const output = {};
  for (const field of OUTPUT_FIELDS) {
    output[field] = normalized[field];
  }

  output.tags = Array.isArray(normalized.tags) ? normalized.tags : [];

  return output;
}

export function buildFinalData(entries, now = new Date()) {
  const leaderboard = entries.map(stripInternalFields);

  return {
    last_updated: now.toISOString(),
    total_devs: leaderboard.length,
    leaderboard
  };
}

/**
 * Atomically writes JSON via a same-directory temp file and rename.
 * Parses the staged file before promoting so readers never see corrupt JSON.
 */
export function atomicWriteJsonSync(targetPath, value) {
  const tmpPath = `${targetPath}.tmp`;

  try {
    const json = JSON.stringify(value);
    fsSync.writeFileSync(tmpPath, json, 'utf8');
    JSON.parse(fsSync.readFileSync(tmpPath, 'utf8'));
    fsSync.renameSync(tmpPath, targetPath);
  } catch (error) {
    try {
      if (fsSync.existsSync(tmpPath)) {
        fsSync.unlinkSync(tmpPath);
      }
    } catch {
      // Best-effort cleanup; preserve the original failure.
    }

    throw error;
  }
}

export async function atomicWriteMinifiedJson(targetPath, value) {
  try {
    atomicWriteJsonSync(targetPath, value);
  } catch (error) {
    console.error(`Module 4 write failed for ${targetPath}: ${error.message}`);
    throw error;
  }
}

export async function writeLeaderboard(entries, options = {}) {
  validateInput(entries);

  const repoRoot = options.repoRoot || process.cwd();
  const outputPath = options.outputPath || path.join(repoRoot, 'public', 'data.json');
  const now = options.now instanceof Date ? options.now : new Date();

  const data = buildFinalData(entries, now);
  await atomicWriteMinifiedJson(outputPath, data);
  console.log(`Module 4 wrote leaderboard with ${data.total_devs} developers -> ${outputPath}`);
}

async function runCli() {
  const inputArg = process.argv[2];
  const outputArg = process.argv[3];

  if (!inputArg) {
    console.error('Usage: node scripts/write-leaderboard.js <input-json> [output-json]');
    process.exit(1);
  }

  const inputPath = path.resolve(process.cwd(), inputArg);
  const outputPath = outputArg
    ? path.resolve(process.cwd(), outputArg)
    : path.join(process.cwd(), 'public', 'data.json');

  const raw = await fs.readFile(inputPath, 'utf8');
  const entries = JSON.parse(raw);
  await writeLeaderboard(entries, { outputPath });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
