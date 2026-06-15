const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildTriageButtons, buildIssueEmbed } = require('../src/services/triage');

function makeIssue(overrides = {}) {
  return {
    summary: 'Gmail sync is broken',
    priority: 'high',
    category: 'integration_bug',
    reporterName: 'alice',
    reasoning: 'User reports Gmail integration stopped syncing after OAuth refresh.',
    guildId: 'g1',
    channelId: 'c1',
    messageId: 'm1',
    ...overrides,
  };
}

describe('buildTriageButtons', () => {
  test('returns two action rows', () => {
    const rows = buildTriageButtons('issue-123');
    assert.equal(rows.length, 2);
  });

  test('row 1 contains ack/fix/wontfix/escalate with the issue id embedded', () => {
    const [row1] = buildTriageButtons('issue-123');
    const ids = row1.components.map(b => b.data.custom_id);
    assert.deepEqual(ids, [
      'triage_ack_issue-123',
      'triage_fix_issue-123',
      'triage_wontfix_issue-123',
      'triage_escalate_issue-123',
    ]);
  });

  test('row 2 contains delete and gather context', () => {
    const [, row2] = buildTriageButtons('issue-123');
    const ids = row2.components.map(b => b.data.custom_id);
    assert.deepEqual(ids, ['triage_delete_issue-123', 'triage_gather_issue-123']);
  });
});

describe('buildIssueEmbed (legacy coverage)', () => {
  test('uses the priority color for known priorities', () => {
    assert.equal(buildIssueEmbed(makeIssue({ priority: 'critical' }), 'id').data.color, 0xff0000);
    assert.equal(buildIssueEmbed(makeIssue({ priority: 'high' }), 'id').data.color, 0xff8c00);
    assert.equal(buildIssueEmbed(makeIssue({ priority: 'medium' }), 'id').data.color, 0xffd700);
    assert.equal(buildIssueEmbed(makeIssue({ priority: 'low' }), 'id').data.color, 0x00cc00);
    assert.equal(buildIssueEmbed(makeIssue({ priority: 'unclassified' }), 'id').data.color, 0x808080);
  });

  test('falls back to gray for an unknown priority', () => {
    assert.equal(buildIssueEmbed(makeIssue({ priority: 'bogus' }), 'id').data.color, 0x808080);
  });

  test('sets the title to the issue summary and footer to the issue id', () => {
    const embed = buildIssueEmbed(makeIssue(), 'issue-123');
    assert.equal(embed.data.title, 'Gmail sync is broken');
    assert.equal(embed.data.footer.text, 'Issue ID: issue-123');
  });

  test('replaces underscores in category with spaces', () => {
    const embed = buildIssueEmbed(makeIssue({ category: 'integration_bug' }), 'id');
    const categoryField = embed.data.fields.find(f => f.name === 'Category');
    assert.equal(categoryField.value, 'integration bug');
  });

  test('defaults category to "other" when missing', () => {
    const issue = makeIssue();
    delete issue.category;
    const embed = buildIssueEmbed(issue, 'id');
    const categoryField = embed.data.fields.find(f => f.name === 'Category');
    assert.equal(categoryField.value, 'other');
  });

  test('adds a jump link when guild/channel/message ids are present', () => {
    const embed = buildIssueEmbed(makeIssue(), 'id');
    const linkField = embed.data.fields.find(f => f.name === 'Original Message');
    assert.notEqual(linkField, undefined);
    assert.ok(linkField.value.includes('https://discord.com/channels/g1/c1/m1'));
  });

  test('shows "MCP Agent" source instead of a jump link when channelId is "mcp"', () => {
    const embed = buildIssueEmbed(
      makeIssue({ channelId: 'mcp', source: 'mcp' }),
      'id',
    );
    assert.equal(embed.data.fields.find(f => f.name === 'Original Message'), undefined);
    const sourceField = embed.data.fields.find(f => f.name === 'Source');
    assert.equal(sourceField.value, 'MCP Agent');
  });

  test('shows "MCP Agent" source when messageId starts with "mcp-"', () => {
    const embed = buildIssueEmbed(
      makeIssue({ messageId: 'mcp-abc', source: 'mcp' }),
      'id',
    );
    assert.equal(embed.data.fields.find(f => f.name === 'Original Message'), undefined);
    assert.equal(embed.data.fields.find(f => f.name === 'Source').value, 'MCP Agent');
  });

  test('includes an Assigned To field only when assigneeName is set', () => {
    const without = buildIssueEmbed(makeIssue(), 'id');
    assert.equal(without.data.fields.find(f => f.name === 'Assigned To'), undefined);
    const withAssignee = buildIssueEmbed(makeIssue({ assigneeName: 'bob' }), 'id');
    assert.equal(withAssignee.data.fields.find(f => f.name === 'Assigned To').value, 'bob');
  });

  test('sets the embed image to the first image attachment and lists all attachments', () => {
    const issue = makeIssue({
      attachments: [
        { name: 'log.txt', url: 'https://cdn.example.com/log.txt', isImage: false, size: 2048 },
        { name: 'screen.png', url: 'https://cdn.example.com/screen.png', isImage: true, size: 10240 },
      ],
    });
    const embed = buildIssueEmbed(issue, 'id');
    assert.equal(embed.data.image.url, 'https://cdn.example.com/screen.png');
    const attField = embed.data.fields.find(f => f.name === 'Attachments');
    assert.ok(attField.value.includes('log.txt'));
    assert.ok(attField.value.includes('screen.png'));
    assert.ok(attField.value.includes('2KB'));
    assert.ok(attField.value.includes('10KB'));
  });

  test('does not set embed image when no image attachments exist', () => {
    const issue = makeIssue({
      attachments: [
        { name: 'log.txt', url: 'https://cdn.example.com/log.txt', isImage: false, size: 100 },
      ],
    });
    const embed = buildIssueEmbed(issue, 'id');
    assert.equal(embed.data.image, undefined);
    const attField = embed.data.fields.find(f => f.name === 'Attachments');
    assert.ok(attField.value.includes('log.txt'));
  });

  test('adds a "Context Complete" field when contextComplete is true', () => {
    const embed = buildIssueEmbed(makeIssue({ contextComplete: true }), 'id');
    assert.notEqual(embed.data.fields.find(f => f.name === '✅ Context Complete'), undefined);
  });

  test('adds a "Gathering Context" field for forum issues that are not yet complete', () => {
    const embed = buildIssueEmbed(makeIssue({ source: 'forum' }), 'id');
    assert.notEqual(embed.data.fields.find(f => f.name === '⏳ Gathering Context'), undefined);
  });
});
