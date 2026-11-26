import { describe, expect, it } from 'vitest';
import { FIELD_MAX, TITLE_MAX, rankRequests, requestIssueUrl } from './feature-requests.js';

describe('requestIssueUrl', () => {
  it("opens the feature request form with the visitor's words in its fields", () => {
    const url = new URL(
      requestIssueUrl({
        title: ' Dark mode ',
        problem: 'Too bright at night',
        proposal: 'A toggle'
      })
    );
    expect(url.origin + url.pathname).toBe('https://github.com/Sudo-Ali-Dev/Rankistan/issues/new');
    expect(url.searchParams.get('template')).toBe('feature_request.yml');
    expect(url.searchParams.get('title')).toBe('Dark mode');
    expect(url.searchParams.get('problem')).toBe('Too bright at night');
    expect(url.searchParams.get('proposal')).toBe('A toggle');
  });

  it('leaves empty fields out and still opens the form', () => {
    const url = new URL(requestIssueUrl({ title: '', problem: '   ' }));
    expect([...url.searchParams.keys()]).toEqual(['template']);
  });

  it('cuts long text so the link stays short enough to open', () => {
    const url = new URL(
      requestIssueUrl({
        title: 'x'.repeat(500),
        problem: 'y'.repeat(9000),
        proposal: 'z'.repeat(9000)
      })
    );
    expect(url.searchParams.get('title')).toHaveLength(TITLE_MAX);
    expect(url.searchParams.get('problem')).toHaveLength(FIELD_MAX);
    expect(url.searchParams.get('proposal')).toHaveLength(FIELD_MAX);
  });
});

describe('rankRequests', () => {
  const issue = (number, votes, createdAt, extra = {}) => ({
    number,
    title: `Request ${number}`,
    html_url: `https://github.com/Sudo-Ali-Dev/Rankistan/issues/${number}`,
    state: 'open',
    comments: 1,
    created_at: createdAt,
    reactions: { '+1': votes },
    ...extra
  });

  it('puts the most wanted first, then the newest', () => {
    const ranked = rankRequests([
      issue(1, 0, '2026-01-01T00:00:00Z'),
      issue(2, 5, '2026-01-02T00:00:00Z'),
      issue(3, 0, '2026-03-01T00:00:00Z')
    ]);
    expect(ranked.map((r) => r.number)).toEqual([2, 3, 1]);
    expect(ranked[0]).toMatchObject({ votes: 5, comments: 1, title: 'Request 2' });
  });

  it('drops pull requests and closed issues', () => {
    const ranked = rankRequests([
      issue(1, 0, '2026-01-01T00:00:00Z', { pull_request: {} }),
      issue(2, 0, '2026-01-01T00:00:00Z', { state: 'closed' }),
      issue(3, 0, '2026-01-01T00:00:00Z')
    ]);
    expect(ranked.map((r) => r.number)).toEqual([3]);
  });

  it('returns nothing for a response that is not a list', () => {
    expect(rankRequests({ message: 'API rate limit exceeded' })).toEqual([]);
    expect(rankRequests(null)).toEqual([]);
  });
});
