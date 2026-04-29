const KEYWORD_DICT = {
  'AI/ML': [
    'ai',
    'machine learning', 'deep learning', 'neural network',
    'language model', 'ml model', 'ai model', 'ai-powered', 'ai tool',
    'artificial intelligence', 'nlp', 'computer vision',
    'transformer', 'classification', 'prediction', 'predictor',
    'training', 'inference', 'dataset', 'llm'
  ],
  'Web Dev': [
    'react', 'vue', 'angular', 'nextjs', 'next.js', 'html',
    'css', 'frontend', 'backend', 'fullstack', 'full-stack',
    'express', 'fastapi', 'django', 'flask', 'tailwind',
    'typescript', 'rest api', 'graphql', 'web app'
  ],
  DevOps: [
    'docker', 'kubernetes', 'ci/cd', 'pipeline', 'terraform',
    'ansible', 'nginx', 'deployment', 'github actions', 'workflow',
    'cloud', 'aws', 'gcp', 'azure', 'infrastructure', 'devops'
  ],
  Mobile: [
    'flutter', 'android', 'ios', 'react native', 'swift',
    'kotlin', 'expo', 'mobile app', 'android app',
    'ios app', 'cross-platform'
  ],
  Data: [
    'pandas', 'spark', 'sql', 'database', 'etl', 'analytics',
    'jupyter', 'data science', 'visualization', 'matplotlib',
    'numpy', 'postgresql', 'mongodb', 'data pipeline',
    'data engineering', 'big data'
  ],
  'Open Source': [
    'library', 'package', 'npm package', 'pip package',
    'sdk', 'cli', 'utility', 'framework', 'open source',
    'plugin', 'boilerplate', 'starter kit', 'template'
  ]
};

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeKeywordForLog(keyword) {
  try {
    return String(keyword);
  } catch {
    return '[unstringifiable-keyword]';
  }
}

function buildRegex(keyword) {
  try {
    const escaped = escapeRegex(keyword);
    return new RegExp(`\\b${escaped}\\b`, 'i');
  } catch (error) {
    console.warn(`[tags] Failed to build regex for keyword: ${safeKeywordForLog(keyword)} (${error.message})`);
    return null;
  }
}

function buildDeveloperCorpus(dev) {
  const topRepos = Array.isArray(dev?.top_repos) ? dev.top_repos : [];
  const digestRepos = Array.isArray(dev?.digest_repos) ? dev.digest_repos : [];
  const topLangs = Array.isArray(dev?.top_languages) ? dev.top_languages : [];

  const parts = [
    dev?.bio == null ? '' : String(dev.bio),
    ...topRepos.map((repo) => (repo?.name == null ? '' : String(repo.name))),
    ...topRepos.map((repo) => (repo?.description == null ? '' : String(repo.description))),
    ...topRepos.map((repo) => (repo?.language == null ? '' : String(repo.language))),
    ...digestRepos.map((repo) => (repo?.name == null ? '' : String(repo.name))),
    ...digestRepos.map((repo) => (repo?.description == null ? '' : String(repo.description))),
    ...digestRepos.map((repo) => (repo?.language == null ? '' : String(repo.language))),
    ...topLangs.map((language) => (language == null ? '' : String(language)))
  ];

  return parts.join(' ').toLowerCase();
}

function matchTagsForDeveloper(dev, keywordDict = KEYWORD_DICT) {
  const corpus = buildDeveloperCorpus(dev);
  const matchedTags = [];

  for (const [tag, keywords] of Object.entries(keywordDict)) {
    if (!Array.isArray(keywords) || keywords.length === 0) {
      continue;
    }

    const matched = keywords.some((keyword) => {
      const regex = buildRegex(keyword);
      if (!regex) {
        return false;
      }

      return regex.test(corpus);
    });

    if (matched) {
      matchedTags.push(tag);
    }
  }

  return matchedTags;
}

function enrichLeaderboardWithTags(leaderboard, keywordDict = KEYWORD_DICT) {
  if (!Array.isArray(leaderboard)) {
    return [];
  }

  return leaderboard.map((dev) => ({
    ...dev,
    tags: matchTagsForDeveloper(dev, keywordDict)
  }));
}

function getAvailableTags(enrichedLeaderboard) {
  if (!Array.isArray(enrichedLeaderboard) || enrichedLeaderboard.length === 0) {
    return [];
  }

  return [...new Set(enrichedLeaderboard.flatMap((dev) => (Array.isArray(dev?.tags) ? dev.tags : [])))].sort();
}

export {
  KEYWORD_DICT,
  escapeRegex,
  safeKeywordForLog,
  buildRegex,
  buildDeveloperCorpus,
  matchTagsForDeveloper,
  enrichLeaderboardWithTags,
  getAvailableTags
};
