const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { jaccardSimilarity, findDuplicate } = require('../src/services/duplicates');

describe('jaccardSimilarity', () => {
  test('returns 1 for identical strings', () => {
    assert.equal(jaccardSimilarity('gmail sync is broken', 'gmail sync is broken'), 1);
  });

  test('returns 0 for completely disjoint strings', () => {
    assert.equal(jaccardSimilarity('gmail sync broken', 'payment invoice failed'), 0);
  });

  test('returns 0 when one side is an empty string', () => {
    assert.equal(jaccardSimilarity('gmail sync broken', ''), 0);
    assert.equal(jaccardSimilarity('', 'gmail sync broken'), 0);
  });

  test('returns 0 when both sides are empty strings', () => {
    assert.equal(jaccardSimilarity('', ''), 0);
  });

  test('returns 0 when tokens are filtered out (all tokens <=2 chars)', () => {
    // tokenize() drops words of length <= 2, so "a an to" -> []
    assert.equal(jaccardSimilarity('a an to', 'a an to'), 0);
  });

  test('is case-insensitive', () => {
    assert.equal(jaccardSimilarity('Gmail Sync Broken', 'gmail SYNC broken'), 1);
  });

  test('ignores punctuation', () => {
    assert.equal(jaccardSimilarity('gmail, sync. broken!', 'gmail sync broken'), 1);
  });

  test('computes partial overlap correctly', () => {
    // tokens A: {gmail, sync, broken} (3)
    // tokens B: {gmail, sync, slow}   (3)
    // intersection: {gmail, sync} = 2; union: {gmail, sync, broken, slow} = 4
    // jaccard = 2/4 = 0.5
    assert.equal(jaccardSimilarity('gmail sync broken', 'gmail sync slow'), 0.5);
  });

  test('deduplicates repeated tokens within a single string', () => {
    // "gmail gmail gmail" -> set {gmail} (1 token)
    // "gmail" -> set {gmail} (1 token)
    // intersection 1, union 1 -> 1
    assert.equal(jaccardSimilarity('gmail gmail gmail', 'gmail'), 1);
  });

  test('throws when passed null or undefined (documents current behavior)', () => {
    // tokenize() calls .toLowerCase() which throws on null/undefined.
    // This is documented behavior, not desirable -- callers must pass strings.
    assert.throws(() => jaccardSimilarity(null, 'x'));
    assert.throws(() => jaccardSimilarity('x', undefined));
  });

  test('handles unicode by dropping non-ASCII word characters', () => {
    // The regex [^a-z0-9\s] strips all non-ASCII letters, so "cafe" with accent becomes "caf"
    // Note: "caf" is length 3, so it survives the length > 2 filter.
    assert.equal(jaccardSimilarity('café', 'caf'), 1);
    // Pure non-ASCII words get fully stripped
    assert.equal(jaccardSimilarity('日本語', '日本語'), 0);
  });
});

describe('findDuplicate', () => {
  const baseIssue = (id, summary, text) => ({ id, summary, text });

  test('returns null when there are no existing issues', () => {
    assert.equal(findDuplicate('gmail broken', 'gmail is not working', []), null);
  });

  test('returns null when nothing exceeds the threshold', () => {
    const existing = [baseIssue('a', 'payment failed', 'my payment failed')];
    assert.equal(findDuplicate('gmail broken', 'gmail is not working', existing), null);
  });

  test('returns the best match above threshold', () => {
    const existing = [
      baseIssue('a', 'gmail sync broken', 'gmail is not syncing at all'),
      baseIssue('b', 'payment failed', 'my card declined'),
    ];
    const match = findDuplicate('gmail sync broken', 'gmail not syncing', existing);
    assert.notEqual(match, null);
    assert.equal(match.issue.id, 'a');
    assert.ok(match.score >= 0.4);
    assert.ok('summarySimilarity' in match);
    assert.ok('textSimilarity' in match);
  });

  test('respects a custom threshold', () => {
    const existing = [baseIssue('a', 'gmail sync broken', 'unrelated text')];
    // Identical summary, unrelated text: score = 1.0*0.6 + 0*0.4 = 0.6
    assert.equal(findDuplicate('gmail sync broken', 'different text', existing, 0.9), null);
    assert.notEqual(findDuplicate('gmail sync broken', 'different text', existing, 0.5), null);
  });

  test('picks the highest-scoring issue when multiple exceed the threshold', () => {
    const existing = [
      baseIssue('weak', 'gmail problem', 'gmail having some trouble'),
      baseIssue('strong', 'gmail sync broken', 'gmail sync is completely broken'),
    ];
    const match = findDuplicate('gmail sync broken', 'gmail sync is completely broken', existing);
    assert.equal(match.issue.id, 'strong');
  });

  test('treats missing summary/text fields on existing issues as empty', () => {
    const existing = [{ id: 'a' }]; // no summary, no text
    assert.equal(findDuplicate('gmail broken', 'gmail is not working', existing), null);
  });
});
