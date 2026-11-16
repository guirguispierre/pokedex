const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { installShutdown } = require('../src/utils/shutdown');
const { startDashboard } = require('../src/dashboard/server');

test('dashboard skips Heroku by default and rejects invalid ports', () => {
  assert.equal(startDashboard({ DYNO: 'worker.1' }), null);
  assert.equal(startDashboard({ DASHBOARD_PORT: 'invalid' }), null);
});

test('dashboard preserves local default and honors an explicit port on Heroku', async () => {
  for (const env of [{}, { DYNO: 'worker.1', DASHBOARD_PORT: '0' }]) {
    const server = startDashboard(env);
    try {
      await once(server, 'listening');
      assert.equal(server.address().address, '127.0.0.1');
      assert.equal(env.DYNO ? server.address().port > 0 : server.address().port === 3000, true);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
});

test('dashboard listen errors do not crash the worker', async () => {
  const first = startDashboard({ DASHBOARD_PORT: '0' });
  await once(first, 'listening');
  const second = startDashboard({ DASHBOARD_PORT: String(first.address().port) });
  try {
    const [error] = await once(second, 'error');
    assert.equal(error.code, 'EADDRINUSE');
  } finally {
    await new Promise(resolve => first.close(resolve));
  }
});

test('shutdown destroys Discord once and exits cleanly for restart signals', async () => {
  const signals = new EventEmitter();
  let destroyed = 0;
  const exits = [];
  installShutdown({ destroy: async () => { destroyed++; } }, { signals, exit: code => exits.push(code) });
  signals.emit('SIGTERM');
  signals.emit('SIGINT');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(destroyed, 1);
  assert.deepEqual(exits, [0]);
});

test('shutdown exits with failure if Discord cleanup fails', async () => {
  const signals = new EventEmitter();
  const exits = [];
  installShutdown({ destroy: async () => { throw new Error('test'); } }, { signals, exit: code => exits.push(code) });
  signals.emit('SIGTERM');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [1]);
});
