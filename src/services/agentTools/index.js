const { searchIssues, schema: searchIssuesSchema } = require('./searchIssues');
const { getStatus, schema: getStatusSchema } = require('./getStatus');
const { readChannel, schema: readChannelSchema } = require('./readChannel');

const HANDLERS = {
  search_issues: searchIssues,
  get_poke_status: getStatus,
  read_channel_context: readChannel,
};

const TOOL_SCHEMAS = [
  searchIssuesSchema,
  getStatusSchema,
  readChannelSchema,
];

async function dispatch(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) return { error: 'unknown_tool', name };
  try {
    return await handler(args || {}, ctx || {});
  } catch (err) {
    return { error: 'tool_threw', message: err.message };
  }
}

module.exports = { TOOL_SCHEMAS, dispatch, HANDLERS };
