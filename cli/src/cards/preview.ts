// The preview deployment URL, fished out of a PR's comment bodies. Ported from
// GitHub.swift's PreviewURL; the shapes are the same, the regex engine is not —
// NSRegularExpression is ICU where this is JS RegExp. The two agree on every
// URL-shaped pattern; a pattern only one engine accepts is dropped here like
// any other typo, with the same visible cost (see `compile`).

/**
 * Deliberately the same pattern poll.sh greps for. The preview link lives only
 * in the Vercel bot's comment — the Vercel check's targetUrl points at the
 * dashboard inspector, not the deployed site.
 *
 * The default rather than the only one: every preview host writes its URL into
 * a bot comment the same way, so a Netlify or Cloudflare Pages deployment needs
 * a pattern and nothing else. `preview.patterns` in the orchestrator's config
 * replaces this list.
 */
export const DEFAULT_PREVIEW_PATTERNS = ['https://[a-z0-9._-]*vercel\\.app[^ )"]*'];

/**
 * An unusable pattern is dropped rather than thrown. It comes from a hand-
 * edited config, and one typo in it must not take the board down — the cost
 * is a missing preview chip, which is visible and recoverable.
 */
function compile(patterns: string[]): RegExp[] {
  const expressions: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      expressions.push(new RegExp(pattern));
    } catch {
      // Dropped silently, like NSRegularExpression's try?.
    }
  }
  return expressions;
}

const defaultExpressions = compile(DEFAULT_PREVIEW_PATTERNS);

/**
 * The first preview URL in a PR's comments, or null. A patterns list replaces
 * the default entirely — even an empty one, which matches nothing — and only a
 * null/undefined `patterns` falls back, the way Swift's `?? defaultExpressions`
 * only fires on nil.
 *
 * The bodies join on "\n", and a negated class like `[^ )"]` matches the
 * newline — same as ICU — so a URL flush against the end of one comment can
 * run into the next. The bot comments these patterns exist for never end
 * mid-URL, so the quirk is kept rather than papered over.
 */
export function firstPreviewMatch(
  bodies: string[],
  patterns?: string[] | null,
): string | null {
  const expressions = patterns == null ? defaultExpressions : compile(patterns);
  const joined = bodies.join('\n');
  // First pattern to match wins, so the order in the config is the operator's
  // order of preference when a PR deploys to more than one host.
  for (const expression of expressions) {
    const match = expression.exec(joined);
    if (match !== null) return match[0];
  }
  return null;
}
