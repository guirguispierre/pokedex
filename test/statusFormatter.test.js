const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  buildSummaryEmbed,
  buildIncidentEmbed,
  buildTransitionEmbed,
  colorForIndicator,
  prettyStatus,
} = require('../src/services/statusFormatter');
const { normalize } = require('../src/services/statusDiff');

const fixture = (name) =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures/status/', name), 'utf-8'));

const STATUS_URL = 'https://status.poke.com';

describe('colorForIndicator', () => {
  test('maps every indicator to its color', () => {
    assert.equal(colorForIndicator('none'), 0x2ECC71);
    assert.equal(colorForIndicator('minor'), 0xF1C40F);
    assert.equal(colorForIndicator('major'), 0xE67E22);
    assert.equal(colorForIndicator('critical'), 0xE74C3C);
    assert.equal(colorForIndicator('maintenance'), 0x3498DB);
  });

  test('falls back to green on unknown indicator', () => {
    assert.equal(colorForIndicator('whatever'), 0x2ECC71);
  });
});

describe('prettyStatus', () => {
  test('title-cases snake_case status', () => {
    assert.equal(prettyStatus('operational'), 'Operational');
    assert.equal(prettyStatus('degraded_performance'), 'Degraded Performance');
    assert.equal(prettyStatus('partial_outage'), 'Partial Outage');
    assert.equal(prettyStatus('major_outage'), 'Major Outage');
    assert.equal(prettyStatus('under_maintenance'), 'Under Maintenance');
  });
});

describe('buildSummaryEmbed', () => {
  test('uses green color and all-operational title when everything is up', () => {
    const snap = normalize(fixture('all-operational.json'));
    const { embed, row } = buildSummaryEmbed(snap, { statusPageUrl: STATUS_URL });
    const j = embed.toJSON();
    assert.equal(j.color, 0x2ECC71);
    assert.ok(j.title.includes('All Systems Operational'));
    assert.equal(row.components.length, 1);
  });

  test('uses critical color when indicator is critical', () => {
    const snap = normalize(fixture('active-incident.json'));
    const { embed } = buildSummaryEmbed(snap, { statusPageUrl: STATUS_URL });
    assert.equal(embed.toJSON().color, 0xE74C3C);
  });

  test('lists every component with emoji and pretty status', () => {
    const snap = normalize(fixture('partial-outage.json'));
    const { embed } = buildSummaryEmbed(snap, { statusPageUrl: STATUS_URL });
    const description = embed.toJSON().description ?? '';
    assert.ok(description.includes('🟢  **App**'));
    assert.ok(description.includes('🟠  **Email**'));
    assert.ok(description.includes('Partial Outage'));
    assert.ok(description.includes('🟡  **iMessage Group**'));
    assert.ok(description.includes('Degraded Performance'));
  });

  test('shows active-incident count in footer or field', () => {
    const snap = normalize(fixture('active-incident.json'));
    const { embed } = buildSummaryEmbed(snap, { statusPageUrl: STATUS_URL });
    const j = JSON.stringify(embed.toJSON());
    assert.match(j, /1/);
  });
});

describe('buildIncidentEmbed', () => {
  test('uses new-incident prefix for kind=new', () => {
    const snap = normalize(fixture('active-incident.json'));
    const embed = buildIncidentEmbed(snap.incidents[0], { kind: 'new', statusPageUrl: STATUS_URL });
    assert.ok(embed.toJSON().title.includes('🚨'));
    assert.ok(embed.toJSON().title.includes('Poke Down'));
  });

  test('uses resolved prefix for kind=resolved', () => {
    const snap = normalize(fixture('incident-resolved.json'));
    const embed = buildIncidentEmbed(snap.incidents[0], { kind: 'resolved', statusPageUrl: STATUS_URL });
    assert.ok(embed.toJSON().title.includes('✅'));
  });

  test('uses update prefix for kind=update', () => {
    const snap = normalize(fixture('active-incident.json'));
    const embed = buildIncidentEmbed(snap.incidents[0], { kind: 'update', statusPageUrl: STATUS_URL });
    assert.ok(embed.toJSON().title.includes('ℹ️'));
  });
});

describe('buildTransitionEmbed', () => {
  test('shows prev and next status names', () => {
    const embed = buildTransitionEmbed(
      { name: 'App', prev: 'operational', next: 'degraded_performance' },
      STATUS_URL,
    );
    const text = JSON.stringify(embed.toJSON());
    assert.ok(text.includes('App'));
    assert.ok(text.includes('Operational'));
    assert.ok(text.includes('Degraded Performance'));
  });
});
