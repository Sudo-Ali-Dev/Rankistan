/**
 * The moderation list: repositories whose commits do not count, each with a public reason and
 * the evidence for it (public/moderation.json, served at rankistan.dev/moderation.json).
 *
 * Scoring v3 excludes on its own what is provably not someone's work: commits dated in the
 * future, author dates hours after their commit dates, commits a bot made in the developer's
 * name (src/model/evidence.js). What it cannot tell apart is a script that commits as the
 * developer every day from a person who works every day. Only a person can, by reading the
 * commits, so that judgement is made here, in the open: one entry per repository, never per
 * developer, so the developer's other work still counts; with the evidence a reader can check;
 * and through a commit, reviewed and dated like any other change. An entry is appealed by
 * opening an issue.
 *
 * Read by the pipeline from its checkout, and by the Worker's preview from the site.
 */
import fs from 'node:fs';

export const MODERATION_PATH = 'public/moderation.json';

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The entries of a moderation document, checked. Throws on anything malformed. */
export function validateModeration(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.repositories)) {
    throw new Error('moderation.json: expected an object with a `repositories` list');
  }
  const seen = new Set();
  return doc.repositories.map((entry, i) => {
    const where = `moderation.json repositories[${i}]`;
    if (!entry || typeof entry !== 'object') throw new Error(`${where}: not an object`);
    const { repo, reason, evidence, added } = entry;
    if (typeof repo !== 'string' || !REPO_RE.test(repo))
      throw new Error(`${where}: repo ${JSON.stringify(repo)}`);
    if (typeof reason !== 'string' || reason.trim().length < 10) {
      throw new Error(`${where}: a reason a reader can understand is required`);
    }
    if (typeof evidence !== 'string' || !evidence.startsWith('https://github.com/')) {
      throw new Error(`${where}: evidence must be a github.com link a reader can open`);
    }
    if (typeof added !== 'string' || !DATE_RE.test(added)) throw new Error(`${where}: added date`);
    if (seen.has(repo.toLowerCase())) throw new Error(`${where}: ${repo} is listed twice`);
    seen.add(repo.toLowerCase());
    return { repo, reason: reason.trim(), evidence, added };
  });
}

/** The list from a file. A missing file is an empty list; a malformed one throws. */
export function loadModerationFile(file) {
  if (!fs.existsSync(file)) return [];
  return validateModeration(JSON.parse(fs.readFileSync(file, 'utf8')));
}
