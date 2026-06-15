// Perceptual-hash math (dHash). Pure: no I/O, no native deps — safe to unit-test
// without sharp installed. The decode step (image bytes -> 9x8 grayscale grid)
// lives in scamscan.js, which feeds dhashFromGrayscale a plain pixel array.

// Build a 64-bit difference hash from a 9-wide x 8-tall grayscale grid (row-major,
// length >= 72). For each of the 8 rows compare each pixel to its right neighbour
// (9 cols -> 8 comparisons), MSB-first -> 64 bits -> 16 hex chars.
function dhashFromGrayscale(pixels, width = 9, height = 8) {
  if (!Array.isArray(pixels) || pixels.length < width * height) {
    throw new Error(`dhashFromGrayscale: expected >= ${width * height} pixels, got ${pixels && pixels.length}`);
  }
  let bits = '';
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width - 1; col++) {
      const left = pixels[row * width + col];
      const right = pixels[row * width + col + 1];
      bits += left > right ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

const HEX_RE = /^[0-9a-f]+$/i;

// Count differing bits between two equal-length hex hashes. Mismatched length or
// non-hex input -> Infinity (callers treat that as "no match").
function hammingDistance(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string') return Infinity;
  if (hexA.length !== hexB.length) return Infinity;
  if (!HEX_RE.test(hexA) || !HEX_RE.test(hexB)) return Infinity;
  let dist = 0;
  for (let i = 0; i < hexA.length; i++) {
    let xor = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    while (xor) { dist += xor & 1; xor >>= 1; }
  }
  return dist;
}

function isHashMatch(hexA, hexB, maxDistance) {
  return hammingDistance(hexA, hexB) <= maxDistance;
}

module.exports = { dhashFromGrayscale, hammingDistance, isHashMatch };
