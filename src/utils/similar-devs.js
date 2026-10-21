/**
 * The developers most like one developer: the ones whose tags overlap theirs the most.
 *
 * The tags are the pipeline's own (src/utils/tag-matcher.js): AI/ML, Web, DevOps and the rest,
 * matched from the bio, the repositories and the languages. They are on the board, so the list is
 * read from board.json and no request is made for it.
 *
 * Equal scores share a rank and their order changes every day, so the order here is the number
 * of shared tags first and the rank second: a developer with the same tags is closer than one
 * who merely scores higher.
 */

/**
 * @param {object[]} rows     every row on the board
 * @param {string} username   the developer to find neighbours for
 * @param {number} limit      how many to return
 * @returns {Array<{dev: object, shared: string[]}>}
 */
export function similarDevelopers(rows, username, { limit = 4 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const wanted = String(username || '')
    .trim()
    .toLowerCase();
  if (!wanted) return [];

  const target = list.find((row) => String(row?.username || '').toLowerCase() === wanted);
  const tags = new Set(Array.isArray(target?.tags) ? target.tags : []);
  if (tags.size === 0) return [];

  const neighbours = [];
  for (const row of list) {
    if (String(row?.username || '').toLowerCase() === wanted) continue;
    const shared = (Array.isArray(row?.tags) ? row.tags : []).filter((tag) => tags.has(tag));
    if (shared.length === 0) continue;
    neighbours.push({ dev: row, shared });
  }

  neighbours.sort((a, b) => {
    if (b.shared.length !== a.shared.length) return b.shared.length - a.shared.length;
    const rankA = Number(a.dev?.rank) || Number.MAX_SAFE_INTEGER;
    const rankB = Number(b.dev?.rank) || Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return String(a.dev?.username || '').localeCompare(String(b.dev?.username || ''));
  });

  return neighbours.slice(0, Math.max(0, limit));
}
