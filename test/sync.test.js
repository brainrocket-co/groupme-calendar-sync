const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = {
  console,
  Date,
  JSON,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest: () => [0, -1, 16]
  },
  Session: { getScriptTimeZone: () => 'America/New_York' }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/Code.js', 'utf8'), context);

test('extracts known GroupMe response shapes', () => {
  assert.equal(context.extractEvents_({ events: [{ id: 1 }] }).length, 1);
  assert.equal(context.extractEvents_({ response: { events: [{ id: 1 }] } }).length, 1);
});

test('normalizes a timed GroupMe event', () => {
  const event = context.normalizeGroupMeEvent_({
    event_id: 'gm-1',
    name: 'Move props',
    start_at: '2026-08-10T18:00:00-04:00',
    end_at: '2026-08-10T19:30:00-04:00',
    timezone: 'America/New_York',
    location: { address: 'Band room' }
  });
  assert.equal(event.groupMeEventId, 'gm-1');
  assert.equal(event.location, 'Band room');
});

test('adds a stable private mapping to Google events', () => {
  const resource = context.toGoogleEventResource_({
    groupMeEventId: 'gm-1', title: 'Move props', description: '', location: '',
    start: '2026-08-10T18:00:00-04:00', end: '2026-08-10T19:00:00-04:00',
    allDay: false, timeZone: 'America/New_York'
  });
  assert.equal(resource.extendedProperties.private.groupmeEventId, 'gm-1');
  assert.equal(resource.start.dateTime, '2026-08-10T18:00:00-04:00');
});

