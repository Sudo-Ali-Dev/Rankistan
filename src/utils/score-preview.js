/**
 * The Register page's score preview: any developer's score measured live by the Worker
 * (cloudflare/score-preview.js), which runs the pipeline's own measurement and model. The browser
 * cannot compute it itself, because the contributions API needs a token.
 *
 * A preview is shown only when the Worker scored it with the model this bundle was built with, so
 * the page never explains one version and displays another.
 */
import { resolveApiBase } from './groq.js';
import { MODEL_VERSION } from '../model/config.js';

export const PREVIEW_TIMEOUT_MS = 30000;

/**
 * @returns {Promise<{ok: true, preview: object} | {ok: false, status: number|null, reason: string}>}
 */
export async function fetchScorePreview(login, { fetchImpl = (...args) => fetch(...args) } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
  try {
    const response = await fetchImpl(
      `${resolveApiBase()}/api/score-preview/${encodeURIComponent(login)}`,
      { signal: controller.signal }
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        reason: body?.error || `HTTP ${response.status}`
      };
    }
    if (body?.model_version !== MODEL_VERSION) {
      return { ok: false, status: response.status, reason: 'The preview is being updated.' };
    }
    return { ok: true, preview: body };
  } catch {
    return { ok: false, status: null, reason: 'The preview could not be reached.' };
  } finally {
    clearTimeout(timer);
  }
}
