const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { normalize, diff } = require('../src/services/statusDiff');

const fixture = (name) =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures/status/', name), 'utf-8'));

describe('normalize', () => {
  test('flattens the summary JSON into snapshot shape', () => {
    const snap = normalize(fixture('all-operational.json'));
    assert.equal(snap.overall.indicator, 'none');
    assert.equal(snap.components.length, 7);
    assert.deepEqual(snap.components[0], {
      id: 'c-app', name: 'App', status: 'operational', updatedAt: '2026-04-16T12:00:00Z',
    });
    assert.deepEqual(snap.incidents, []);
  });

  test('carries incidents with their updates', () => {
    const snap = normalize(fixture('active-incident.json'));
    assert.equal(snap.incidents.length, 1);
    assert.equal(snap.incidents[0].id, 'inc-poke-down');
    assert.equal(snap.incidents[0].updates.length, 1);
    assert.equal(snap.incidents[0].updates[0].status, 'investigating');
  });
});

describe('diff', () => {
  test('reports no changes when prev is null AND next is all-green with no incidents', () => {
    const next = normalize(fixture('all-operational.json'));
    const d = diff(null, next);
    assert.equal(d.overallChanged, false);
    assert.deepEqual(d.componentTransitions, []);
    assert.deepEqual(d.incidentsCreated, []);
    assert.deepEqual(d.incidentsResolved, []);
    assert.deepEqual(d.incidentsUpdated, []);
  });

  test('when prev is null and there is an active incident, reports it as created (no component alerts)', () => {
    const next = normalize(fixture('active-incident.json'));
    const d = diff(null, next);
    assert.deepEqual(d.componentTransitions, []);
    assert.equal(d.incidentsCreated.length, 1);
    assert.equal(d.incidentsCreated[0].id, 'inc-poke-down');
  });

  test('detects component transitions when status changes', () => {
    const prev = normalize(fixture('all-operational.json'));
    const next = normalize(fixture('partial-outage.json'));
    const d = diff(prev, next);
    assert.equal(d.overallChanged, true);
    const transitions = d.componentTransitions.map(t => `${t.name}:${t.prev}->${t.next}`);
    assert.ok(transitions.includes('Email:operational->partial_outage'));
    assert.ok(transitions.includes('iMessage Group:operational->degraded_performance'));
    assert.equal(d.componentTransitions.length, 2);
  });

  test('detects a new incident appearing', () => {
    const prev = normalize(fixture('partial-outage.json'));
    const next = normalize(fixture('active-incident.json'));
    const d = diff(prev, next);
    assert.deepEqual(d.incidentsCreated.map(i => i.id), ['inc-poke-down']);
    assert.deepEqual(d.incidentsResolved, []);
  });

  test('detects an incident resolving', () => {
    const prev = normalize(fixture('active-incident.json'));
    const next = normalize(fixture('incident-resolved.json'));
    const d = diff(prev, next);
    assert.deepEqual(d.incidentsResolved.map(i => i.id), ['inc-poke-down']);
    assert.deepEqual(d.incidentsCreated, []);
  });

  test('detects new incident updates on a still-open incident', () => {
    const prev = normalize(fixture('active-incident.json'));
    const nextRaw = fixture('active-incident.json');
    nextRaw.incidents[0].incident_updates.unshift({
      body: 'Identified the cause.',
      status: 'identified',
      created_at: '2026-04-16T16:30:00Z',
    });
    nextRaw.incidents[0].status = 'identified';
    const next = normalize(nextRaw);
    const d = diff(prev, next);
    assert.equal(d.incidentsUpdated.length, 1);
    assert.equal(d.incidentsUpdated[0].newUpdates.length, 1);
    assert.equal(d.incidentsUpdated[0].newUpdates[0].body, 'Identified the cause.');
  });

  test('returns no changes when two identical snapshots are diffed', () => {
    const snap = normalize(fixture('partial-outage.json'));
    const d = diff(snap, snap);
    assert.equal(d.overallChanged, false);
    assert.deepEqual(d.componentTransitions, []);
    assert.deepEqual(d.incidentsCreated, []);
    assert.deepEqual(d.incidentsResolved, []);
    assert.deepEqual(d.incidentsUpdated, []);
  });
});
