const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dhashFromGrayscale, hammingDistance, isHashMatch } = require('../src/services/phash');

// 9x8 grid = 72 pixels. Each row strictly increasing left->right: every
// "left > right" comparison is false -> all 64 bits are 0 -> 16 hex zeros.
function increasingGrid() {
  const px = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 9; c++) px.push(c);
  return px;
}
// Each row strictly decreasing: every comparison true -> all bits 1 -> all f.
function decreasingGrid() {
  const px = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 9; c++) px.push(8 - c);
  return px;
}

test('dhashFromGrayscale: increasing rows -> all-zero hash', () => {
  assert.equal(dhashFromGrayscale(increasingGrid()), '0000000000000000');
});

test('dhashFromGrayscale: decreasing rows -> all-one hash', () => {
  assert.equal(dhashFromGrayscale(decreasingGrid()), 'ffffffffffffffff');
});

test('dhashFromGrayscale: too few pixels throws', () => {
  assert.throws(() => dhashFromGrayscale([1, 2, 3]));
});

test('hammingDistance: identical -> 0, opposite -> 64', () => {
  assert.equal(hammingDistance('ffffffffffffffff', 'ffffffffffffffff'), 0);
  assert.equal(hammingDistance('ffffffffffffffff', '0000000000000000'), 64);
});

test('hammingDistance: one differing nibble bit -> 1', () => {
  assert.equal(hammingDistance('0000000000000000', '0000000000000001'), 1);
});

test('hammingDistance: length mismatch or non-hex -> Infinity', () => {
  assert.equal(hammingDistance('ff', 'ffff'), Infinity);
  assert.equal(hammingDistance('zz', 'zz'), Infinity);
  assert.equal(hammingDistance(null, 'ff'), Infinity);
});

test('isHashMatch: respects the max distance boundary', () => {
  assert.equal(isHashMatch('0000000000000000', '0000000000000003', 2), true);  // 2 bits
  assert.equal(isHashMatch('0000000000000000', '0000000000000007', 2), false); // 3 bits
});
