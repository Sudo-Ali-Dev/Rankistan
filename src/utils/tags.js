import {
  KEYWORD_DICT,
  escapeRegex,
  safeKeywordForLog,
  buildRegex,
  buildDeveloperCorpus,
  matchTagsForDeveloper
} from './tag-matcher.js';

function ensureLeaderboardTags(leaderboard, keywordDict = KEYWORD_DICT) {
  if (!Array.isArray(leaderboard)) {
    return [];
  }

  return leaderboard.map((dev) => {
    const hasTags = Array.isArray(dev?.tags) && dev.tags.length > 0;
    if (hasTags) {
      return dev;
    }

    return {
      ...dev,
      tags: matchTagsForDeveloper(dev, keywordDict)
    };
  });
}

function getAvailableTags(enrichedLeaderboard) {
  if (!Array.isArray(enrichedLeaderboard) || enrichedLeaderboard.length === 0) {
    return [];
  }

  return [
    ...new Set(
      enrichedLeaderboard.flatMap((dev) => (Array.isArray(dev?.tags) ? dev.tags : []))
    )
  ].sort();
}

export {
  KEYWORD_DICT,
  escapeRegex,
  safeKeywordForLog,
  buildRegex,
  buildDeveloperCorpus,
  matchTagsForDeveloper,
  ensureLeaderboardTags,
  getAvailableTags
};
