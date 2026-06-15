const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { extractTags, inferSource } = require('../src/recipes/extractors');

describe('extractTags', () => {
  test('returns empty array for empty or nullish input', () => {
    assert.deepEqual(extractTags(''), []);
    assert.deepEqual(extractTags(null), []);
    assert.deepEqual(extractTags(undefined), []);
  });

  test('matches topic keywords with word boundaries', () => {
    for (const tag of ['travel', 'tripit', 'tracker']) {
      assert.ok(extractTags('track my flight on Tripit').includes(tag), `expected tag ${tag}`);
    }
    for (const tag of ['summarizer', 'gmail']) {
      assert.ok(extractTags('summarize my Gmail inbox').includes(tag), `expected tag ${tag}`);
    }
    for (const tag of ['finance', 'assistant']) {
      assert.ok(extractTags('a tax oracle assistant').includes(tag), `expected tag ${tag}`);
    }
  });

  test('does NOT match substrings of unrelated words', () => {
    // "notify" must use word boundary, so "notified" should NOT trigger.
    assert.ok(!extractTags('I was notifying my team').includes('notify'));
    // "code" is a common English word; ensure we don't match inside "encoded" or "barcode".
    assert.ok(!extractTags('encoded data').includes('coding'));
    assert.ok(!extractTags('barcode scanner').includes('coding'));
  });

  test('matches multi-word phrase keywords', () => {
    assert.ok(extractTags('this integrates with google calendar').includes('google-calendar'));
    for (const tag of ['apple-music', 'music', 'assistant']) {
      assert.ok(extractTags('apple music playlist helper').includes(tag), `expected tag ${tag}`);
    }
  });

  test('deduplicates tags', () => {
    const result = extractTags('travel travel travel TRAVEL');
    assert.equal(result.filter((t) => t === 'travel').length, 1);
  });
});

describe('inferSource', () => {
  test('returns canonical name for known hostnames', () => {
    assert.equal(inferSource('https://poke.com/r/ABC123'), 'Poke');
    assert.equal(inferSource('https://github.com/user/repo'), 'GitHub');
    assert.equal(inferSource('https://docs.google.com/document/d/xyz'), 'Google Docs');
    assert.equal(inferSource('https://www.youtube.com/watch?v=123'), 'YouTube');
    assert.equal(inferSource('https://youtu.be/123'), 'YouTube');
    assert.equal(inferSource('https://www.reddit.com/r/something'), 'Reddit');
    assert.equal(inferSource('https://notion.so/some-page'), 'Notion');
    assert.equal(inferSource('https://notion.site/public-page'), 'Notion');
  });

  test('recognizes re-added sources with exact domain matching', () => {
    assert.equal(inferSource('https://pokepast.es/xyz'), 'Pokepaste');
    assert.equal(inferSource('https://www.smogon.com/forums/threads/xyz'), 'Smogon');
  });

  test('returns null for unknown hostnames', () => {
    assert.equal(inferSource('https://random-site.example/x'), null);
    assert.equal(inferSource('https://ogeneo.foo.com/y'), null);
  });

  test('returns null for unparseable URLs', () => {
    assert.equal(inferSource('not a url'), null);
    assert.equal(inferSource(''), null);
  });
});
