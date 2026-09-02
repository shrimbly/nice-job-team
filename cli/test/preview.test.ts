// The preview-URL cases from PortabilityTests.swift ("Which preview host"),
// case for case, against the ported matcher.

import { describe, expect, test } from 'vitest';
import { DEFAULT_PREVIEW_PATTERNS, firstPreviewMatch } from '../src/cards/preview.js';

const netlify = 'Deploy Preview ready: https://deploy-preview-9--site.netlify.app done';
const netlifyPattern = 'https://[a-z0-9._-]*netlify\\.app[^ )"]*';

describe('which preview host', () => {
  test('Vercel is still matched with no configuration at all', () => {
    const comment = 'Preview: https://board-abc123.vercel.app ready';
    expect(firstPreviewMatch([comment])).toBe('https://board-abc123.vercel.app');
    expect(firstPreviewMatch([netlify])).toBeNull();
  });

  test('another preview host needs a pattern and nothing else', () => {
    expect(firstPreviewMatch([netlify], [netlifyPattern])).toBe(
      'https://deploy-preview-9--site.netlify.app',
    );
  });

  test('the first pattern to match wins, so config order is preference order', () => {
    const both = 'https://a.vercel.app and https://b.netlify.app';
    const netlifyFirst = [netlifyPattern, DEFAULT_PREVIEW_PATTERNS[0]];
    expect(firstPreviewMatch([both], netlifyFirst)).toBe('https://b.netlify.app');
  });

  // The patterns come from a hand-edited config. One typo must cost a preview
  // chip, not the board.
  test('an unusable pattern is dropped rather than crashing the board', () => {
    const patterns = ['*** not a regex (', netlifyPattern];
    expect(firstPreviewMatch([netlify], patterns)).toBe(
      'https://deploy-preview-9--site.netlify.app',
    );
  });

  // Ported behavior the Swift cases only imply: a patterns list replaces the
  // default entirely — an empty list matches nothing, only nil falls back —
  // and the comment bodies are one joined text, so a later comment's URL is
  // still found.
  test('a patterns list replaces the default; only its absence falls back', () => {
    expect(firstPreviewMatch(['see https://x.vercel.app now'], [])).toBeNull();
    expect(firstPreviewMatch(['see https://x.vercel.app now'], null)).toBe('https://x.vercel.app');
    expect(firstPreviewMatch(['nothing here', 'then https://y.vercel.app came up'])).toBe(
      'https://y.vercel.app',
    );
  });
});

// Not ported, deliberately — "preview patterns are read from config"
// (previewPatternsFromConfig) exercises BoardConfig.load pulling
// `preview.patterns` out of config.json before handing it to the matcher.
// That plumbing belongs to config.ts and its tests; this file covers the
// matcher the patterns are handed to.
