function installShutdown(client, { signals = process, exit = code => process.exit(code) } = {}) {
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => exit(1), 10000);
    timeout.unref();
    try {
      await client.destroy();
      exit(0);
    } catch {
      console.error('Failed to destroy Discord client during shutdown.');
      exit(1);
    } finally {
      clearTimeout(timeout);
    }
  };
  signals.on('SIGTERM', shutdown);
  signals.on('SIGINT', shutdown);
}

module.exports = { installShutdown };
