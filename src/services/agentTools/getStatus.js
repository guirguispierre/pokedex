const { createFetcher } = require('../statusFetcher');
const { getConfig } = require('../../config/config');

async function getStatus(_args, _ctx) {
  if (!getConfig('status_enabled')) {
    return { unavailable: true, reason: 'status_disabled_in_config' };
  }

  try {
    const fetcher = createFetcher({
      timeoutMs: getConfig('status_fetch_timeout_ms') || 10000,
    });

    const apiUrl = getConfig('status_api_url') || 'https://status.poke.com/api/v2/summary.json';
    const summary = await fetcher.fetchSummary(apiUrl);

    return {
      overall: summary?.status?.indicator || summary?.overall || 'unknown',
      incidents: (summary?.incidents || []).map(i => ({
        name: i.name,
        status: i.status,
        startedAt: i.started_at || i.startedAt || null,
      })),
    };
  } catch (err) {
    return { unavailable: true, reason: `fetch_failed: ${err.message}` };
  }
}

const schema = {
  type: 'function',
  function: {
    name: 'get_poke_status',
    description: 'Get the current live status of poke.com. Use this when a bug report mentions a service being down or integrations broken — there may be an active incident.',
    parameters: { type: 'object', properties: {} },
  },
};

module.exports = { getStatus, schema };
