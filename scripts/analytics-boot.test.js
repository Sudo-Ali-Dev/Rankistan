// The analytics boot script inline in index.html: the UTM-to-path rewrite and the beacon loader.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';

const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
const source = /<script id="analytics-boot">([\s\S]*?)<\/script>/.exec(html)[1];

function boot(url, { token = '' } = {}) {
  const window = new Window({ url });
  window.eval(
    source.replace(/var CF_WEB_ANALYTICS_TOKEN = '[^']*';/, `var CF_WEB_ANALYTICS_TOKEN = '${token}';`)
  );
  const beacon = window.document.querySelector('script[src*="cloudflareinsights"]');
  const { pathname, search, hash } = window.location;
  window.close();
  return { url: pathname + search + hash, beacon };
}

describe('analytics boot script', () => {
  it('turns a UTM landing into a path Cloudflare can see, and drops the utm_* parameters', () => {
    expect(
      boot('https://rankistan.dev/?utm_source=LinkedIn&utm_medium=social&utm_campaign=Infra 1').url
    ).toBe('/from/linkedin/infra-1');
  });

  it('keeps other parameters and the developer hash', () => {
    expect(boot('https://rankistan.dev/?utm_source=github&search=ali#NadirAliOfficial').url).toBe(
      '/from/github/none?search=ali#NadirAliOfficial'
    );
  });

  it('reduces values to safe path segments of at most 40 characters', () => {
    const { url } = boot(
      `https://rankistan.dev/?utm_source=${'x'.repeat(80)}&utm_campaign=../../etc`
    );
    expect(url).toBe(`/from/${'x'.repeat(40)}/etc`);
  });

  it('leaves every other URL alone', () => {
    for (const url of [
      'https://rankistan.dev/',
      'https://rankistan.dev/map?utm_source=x',
      'https://rankistan.dev/#someone'
    ]) {
      expect(boot(url).url).toBe(new URL(url).pathname + new URL(url).search + new URL(url).hash);
    }
  });

  it('loads the beacon only on rankistan.dev, and only with a token', () => {
    expect(boot('https://rankistan.dev/').beacon).toBeNull();
    expect(boot('http://localhost:5173/', { token: 'abc' }).beacon).toBeNull();
    const { beacon } = boot('https://rankistan.dev/', { token: 'abc' });
    expect(beacon).not.toBeNull();
    expect(JSON.parse(beacon.getAttribute('data-cf-beacon'))).toEqual({ token: 'abc', spa: true });
    expect(beacon.defer).toBe(true);
  });
});
