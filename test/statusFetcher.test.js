const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createFetcher } = require('../src/services/statusFetcher');

function okFetch(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

function failFetch(status = 500) {
  return async () => ({ ok: false, status, json: async () => ({}) });
}

function throwFetch(err) {
  return async () => { throw err; };
}

describe('createFetcher', () => {
  test('returns parsed JSON on success and resets consecutiveFailures', async () => {
    const fetcher = createFetcher({ fetchFn: okFetch({ ok: 1 }) });
    const body = await fetcher.fetchSummary('https://example.test/summary.json');
    assert.deepEqual(body, { ok: 1 });
    assert.equal(fetcher.getConsecutiveFailures(), 0);
  });

  test('throws on non-2xx and increments consecutiveFailures', async () => {
    const fetcher = createFetcher({ fetchFn: failFetch(503) });
    await assert.rejects(() => fetcher.fetchSummary('https://example.test/x'), /503/);
    assert.equal(fetcher.getConsecutiveFailures(), 1);
  });

  test('throws on fetch rejection and increments counter', async () => {
    const fetcher = createFetcher({ fetchFn: throwFetch(new Error('net-down')) });
    await assert.rejects(() => fetcher.fetchSummary('https://example.test/x'), /net-down/);
    assert.equal(fetcher.getConsecutiveFailures(), 1);
  });

  test('accumulates failures until a success resets the counter', async () => {
    let shouldFail = true;
    const fetchFn = async () => {
      if (shouldFail) throw new Error('down');
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const fetcher = createFetcher({ fetchFn });
    await assert.rejects(() => fetcher.fetchSummary('u'));
    await assert.rejects(() => fetcher.fetchSummary('u'));
    assert.equal(fetcher.getConsecutiveFailures(), 2);
    shouldFail = false;
    await fetcher.fetchSummary('u');
    assert.equal(fetcher.getConsecutiveFailures(), 0);
  });

  test('aborts the request when the timeout elapses', async () => {
    const fetchFn = (_url, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const fetcher = createFetcher({ fetchFn, timeoutMs: 10 });
    await assert.rejects(() => fetcher.fetchSummary('u'), /abort/i);
    assert.equal(fetcher.getConsecutiveFailures(), 1);
  });
});
