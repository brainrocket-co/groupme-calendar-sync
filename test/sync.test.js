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

test('builds an organized description with details and named RSVPs', () => {
  const description = context.buildGoogleDescription_({
    description: 'Dinner before rehearsal.',
    links: [
      { type: 'dress_code', name: 'Blue shirt' },
      { type: 'info', name: 'Bring gloves' },
      { type: 'link', name: 'Competition site', url: 'https://example.com' }
    ],
    capacity: 4,
    going: ['1'],
    maybe_going: ['2'],
    not_going: [],
    share_url: 'https://groupme.com/join_event/example'
  }, { '1': 'Doug', '2': 'Pat', '3': 'Sam' });

  assert.match(description, /Dress Code: Blue shirt/);
  assert.match(description, /Link: Competition site\nhttps:\/\/example.com/);
  assert.match(description, /Needed \(4\)/);
  assert.match(description, /Going \(1\): Doug/);
  assert.match(description, /Maybe \(1\): Pat/);
  assert.match(description, /Pending \(1\)(?!:)/);
  assert.ok(description.indexOf('GROUPME RSVPs') < description.indexOf('EVENT DETAILS'));
});

test('renders future link types generically with optional URLs', () => {
  const lines = context.buildEventDetailLines_([
    { type: 'payment', name: '$10 due', url: 'https://example.com/pay' },
    { type: 'restrictions', name: 'Adults only' },
    { type: 'future_link_type', name: 'Still works' }
  ]);
  assert.deepEqual(Array.from(lines), [
    'Payment: $10 due\nhttps://example.com/pay',
    'Restrictions: Adults only',
    'Future Link Type: Still works'
  ]);
});

test('falls back to RSVP counts if member lookup is unavailable', () => {
  const lines = context.buildRsvpLines_({
    going: ['1'], maybe_going: [], not_going: []
  }, null);
  assert.deepEqual(Array.from(lines), ['Going (1)', 'Maybe (0)', "Can't go (0)"]);
});

test('adds a stable private mapping to Google events', () => {
  const resource = context.toGoogleEventResource_({
    groupMeEventId: 'gm-1', title: 'Move props', description: '', location: '',
    start: '2026-08-10T18:00:00-04:00', end: '2026-08-10T19:00:00-04:00',
    allDay: false, timeZone: 'America/New_York', sourceUrl: 'https://groupme.com/join_event/example'
  });
  assert.equal(resource.extendedProperties.private.groupmeEventId, 'gm-1');
  assert.equal(resource.start.dateTime, '2026-08-10T18:00:00-04:00');
  assert.equal(resource.source.url, 'https://groupme.com/join_event/example');
});
