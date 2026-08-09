/**
 * GroupMe -> Google Calendar one-way mirror.
 * GroupMe is authoritative. Configuration and state live in Script Properties.
 */

var SETTINGS = Object.freeze({
  GROUPME_BASE_URL: 'https://api.groupme.com/v3',
  FETCH_LIMIT: 100,
  DEFAULT_EVENT_MINUTES: 60,
  STATE_PROPERTY: 'SYNC_STATE_V1',
  REQUIRED_PROPERTIES: ['GROUPME_TOKEN', 'GROUPME_GROUP_ID', 'GOOGLE_CALENDAR_ID']
});

function syncGroupMeToGoogleCalendar() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    var config = getConfig_();
    var state = loadState_();
    var fetched = fetchGroupMeEvents_(config);
    var memberDirectory = fetchGroupMeMemberDirectorySafely_(config);
    var seen = {};
    var stats = { fetched: fetched.events.length, created: 0, updated: 0, unchanged: 0, deleted: 0 };

    fetched.events.forEach(function (groupMeEvent) {
      var normalized = normalizeGroupMeEvent_(groupMeEvent, memberDirectory);
      seen[normalized.groupMeEventId] = true;
      var existing = state[normalized.groupMeEventId];
      var googleEventId = existing && existing.googleEventId;
      if (existing && googleEventId && existing.fingerprint === normalized.fingerprint) {
        stats.unchanged += 1;
        return;
      }
      var result = upsertGoogleEvent_(config.calendarId, googleEventId, normalized);
      state[normalized.groupMeEventId] = {
        googleEventId: result.googleEventId,
        start: normalized.start,
        fingerprint: normalized.fingerprint
      };
      stats[result.created ? 'created' : 'updated'] += 1;
    });

    // Delete only when the result set is known not to have hit its limit. This
    // avoids deleting valid events if GroupMe silently truncates the response.
    if (fetched.isComplete) {
      Object.keys(state).forEach(function (groupMeEventId) {
        var record = state[groupMeEventId];
        if (!seen[groupMeEventId] && new Date(record.start).getTime() >= Date.now()) {
          deleteGoogleEventIfPresent_(config.calendarId, record.googleEventId);
          delete state[groupMeEventId];
          stats.deleted += 1;
        }
      });
    } else {
      console.warn('GroupMe returned the fetch limit; missing-event deletion was skipped.');
    }

    saveState_(state);
    console.log(JSON.stringify(stats));
    return stats;
  } finally {
    lock.releaseLock();
  }
}

function fetchGroupMeEvents_(config) {
  var params = [
    'end_at=' + encodeURIComponent(new Date().toISOString()),
    'limit=' + SETTINGS.FETCH_LIMIT
  ].join('&');
  var url = SETTINGS.GROUPME_BASE_URL + '/conversations/' +
    encodeURIComponent(config.groupId) + '/events/list?' + params;
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'X-Access-Token': config.token },
    muteHttpExceptions: true
  });
  var status = response.getResponseCode();
  var body = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('GroupMe request failed (' + status + '): ' + redactToken_(body, config.token));
  }
  var parsed = JSON.parse(body);
  var events = extractEvents_(parsed);
  return { events: events, isComplete: events.length < SETTINGS.FETCH_LIMIT };
}

/**
 * Diagnostic helper for discovering GroupMe's current, undocumented event
 * fields. Run manually from the Apps Script editor, then inspect the log.
 * The access token and Google Calendar ID are never included in the output.
 */
function inspectLatestGroupMeEventPayload() {
  var config = getConfig_();
  var fetched = fetchGroupMeEvents_(config);
  if (!fetched.events.length) {
    throw new Error('No upcoming GroupMe events were found.');
  }

  var listEvent = fetched.events[0];
  var eventId = String(listEvent.event_id || listEvent.id || '');
  if (!eventId) throw new Error('The first GroupMe event has no event ID.');

  var details = fetchGroupMeEventDetails_(config, eventId);
  var diagnostic = {
    note: 'No GroupMe token or Google Calendar ID is included in this output.',
    listEvent: listEvent,
    eventDetails: details
  };
  console.log(JSON.stringify(diagnostic, null, 2));
  return diagnostic;
}

function fetchGroupMeEventDetails_(config, eventId) {
  var url = SETTINGS.GROUPME_BASE_URL + '/conversations/' +
    encodeURIComponent(config.groupId) + '/events/show?event_id=' + encodeURIComponent(eventId);
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'X-Access-Token': config.token },
    muteHttpExceptions: true
  });
  var status = response.getResponseCode();
  var body = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('GroupMe event-details request failed (' + status + '): ' +
      redactToken_(body, config.token));
  }
  var parsed = JSON.parse(body);
  if (parsed.event) return parsed.event;
  if (parsed.response && parsed.response.event) return parsed.response.event;
  if (parsed.response) return parsed.response;
  return parsed;
}

function fetchGroupMeMemberDirectorySafely_(config) {
  try {
    return fetchGroupMeMemberDirectory_(config);
  } catch (error) {
    console.warn('GroupMe member lookup failed; RSVP counts will be shown without names: ' + error);
    return null;
  }
}

function fetchGroupMeMemberDirectory_(config) {
  var url = SETTINGS.GROUPME_BASE_URL + '/groups/' + encodeURIComponent(config.groupId);
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'X-Access-Token': config.token },
    muteHttpExceptions: true
  });
  var status = response.getResponseCode();
  var body = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('GroupMe group request failed (' + status + '): ' + redactToken_(body, config.token));
  }
  var parsed = JSON.parse(body);
  var group = parsed.response || parsed;
  var members = Array.isArray(group.members) ? group.members : [];
  return members.reduce(function (directory, member) {
    var id = String(member.user_id || member.id || '');
    if (id) directory[id] = String(member.nickname || member.name || 'Unknown member');
    return directory;
  }, {});
}

function extractEvents_(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.events)) return payload.events;
  if (payload.response && Array.isArray(payload.response.events)) return payload.response.events;
  throw new Error('Unexpected GroupMe events response shape.');
}

function normalizeGroupMeEvent_(event, memberDirectory) {
  var id = String(event.event_id || event.id || '');
  var title = String(event.name || '').trim();
  var start = event.start_at;
  if (!id || !title || !start) throw new Error('GroupMe event is missing id, name, or start_at.');

  var allDay = Boolean(event.is_all_day);
  var end = event.end_at || new Date(
    new Date(start).getTime() + SETTINGS.DEFAULT_EVENT_MINUTES * 60000
  ).toISOString();
  var location = event.location || {};
  var normalized = {
    groupMeEventId: id,
    title: title,
    description: buildGoogleDescription_(event, memberDirectory),
    location: String(location.address || location.name || ''),
    start: start,
    end: end,
    allDay: allDay,
    timeZone: event.timezone || Session.getScriptTimeZone(),
    sourceUrl: String(event.share_url || 'https://groupme.com/')
  };
  normalized.fingerprint = fingerprint_(normalized);
  return normalized;
}

function buildGoogleDescription_(event, memberDirectory) {
  var sections = [];
  var originalDescription = String(event.description || '').trim();
  if (originalDescription) sections.push(originalDescription);

  var rsvpLines = buildRsvpLines_(event, memberDirectory);
  if (event.share_url) {
    rsvpLines.push('', 'RSVP or view updates in GroupMe:', event.share_url);
  }
  if (rsvpLines.length) sections.push('GROUPME RSVPs\n' + rsvpLines.join('\n'));

  var detailLines = buildEventDetailLines_(event.links || []);
  if (detailLines.length) sections.push('EVENT DETAILS\n' + detailLines.join('\n\n'));
  return sections.join('\n\n');
}

function buildEventDetailLines_(links) {
  var lines = [];
  links.forEach(function (link) {
    if (!link || (!link.name && !link.url)) return;
    var label = toTitleCase_(link.type || 'detail');
    var line = label + (link.name ? ': ' + link.name : '');
    if (link.url) line += '\n' + link.url;
    lines.push(line);
  });
  return lines;
}

function toTitleCase_(value) {
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, function (character) { return character.toUpperCase(); });
}

function buildRsvpLines_(event, memberDirectory) {
  var going = stringIds_(event.going);
  var maybe = stringIds_(event.maybe_going);
  var notGoing = stringIds_(event.not_going);
  var lines = [];
  if (event.capacity !== null && event.capacity !== undefined && event.capacity !== '') {
    lines.push('Needed (' + event.capacity + ')');
  }
  lines = lines.concat([
    formatRsvpLine_('Going', going, memberDirectory),
    formatRsvpLine_('Maybe', maybe, memberDirectory),
    formatRsvpLine_("Can't go", notGoing, memberDirectory)
  ]);

  // Pending means active group members who have not selected any RSVP option.
  // It can only be calculated when the member directory request succeeds.
  if (memberDirectory) {
    var answered = {};
    going.concat(maybe, notGoing).forEach(function (id) { answered[id] = true; });
    var pending = Object.keys(memberDirectory).filter(function (id) { return !answered[id]; });
    lines.push(formatRsvpLine_('Pending', pending, null));
  }
  return lines;
}

function formatRsvpLine_(label, ids, memberDirectory) {
  var suffix = '';
  if (ids.length && memberDirectory) {
    suffix = ': ' + ids.map(function (id) { return memberDirectory[id] || 'Unknown member'; }).join(', ');
  }
  return label + ' (' + ids.length + ')' + suffix;
}

function stringIds_(value) {
  return Array.isArray(value) ? value.map(function (id) { return String(id); }) : [];
}

function upsertGoogleEvent_(calendarId, googleEventId, event) {
  var resource = toGoogleEventResource_(event);
  if (googleEventId) {
    try {
      Calendar.Events.patch(resource, calendarId, googleEventId, { sendUpdates: 'none' });
      return { googleEventId: googleEventId, created: false };
    } catch (error) {
      if (!isNotFound_(error)) throw error;
    }
  }
  var created = Calendar.Events.insert(resource, calendarId, { sendUpdates: 'none' });
  return { googleEventId: created.id, created: true };
}

function toGoogleEventResource_(event) {
  var resource = {
    summary: event.title,
    description: event.description,
    location: event.location,
    extendedProperties: { private: { groupmeEventId: event.groupMeEventId } },
    source: { title: 'GroupMe event', url: event.sourceUrl || 'https://groupme.com/' }
  };
  if (event.allDay) {
    resource.start = { date: String(event.start).slice(0, 10) };
    // Google Calendar all-day end dates are exclusive.
    resource.end = { date: String(event.end).slice(0, 10) };
  } else {
    resource.start = { dateTime: event.start, timeZone: event.timeZone };
    resource.end = { dateTime: event.end, timeZone: event.timeZone };
  }
  return resource;
}

function deleteGoogleEventIfPresent_(calendarId, googleEventId) {
  if (!googleEventId) return;
  try {
    Calendar.Events.remove(calendarId, googleEventId, { sendUpdates: 'none' });
  } catch (error) {
    if (!isNotFound_(error)) throw error;
  }
}

function getConfig_() {
  var values = PropertiesService.getScriptProperties().getProperties();
  var missing = SETTINGS.REQUIRED_PROPERTIES.filter(function (name) { return !values[name]; });
  if (missing.length) throw new Error('Missing Script Properties: ' + missing.join(', '));
  return {
    token: values.GROUPME_TOKEN,
    groupId: values.GROUPME_GROUP_ID,
    calendarId: values.GOOGLE_CALENDAR_ID
  };
}

function loadState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(SETTINGS.STATE_PROPERTY);
  return raw ? JSON.parse(raw) : {};
}

function saveState_(state) {
  PropertiesService.getScriptProperties().setProperty(SETTINGS.STATE_PROPERTY, JSON.stringify(state));
}

function createSyncTrigger() {
  deleteSyncTriggers();
  ScriptApp.newTrigger('syncGroupMeToGoogleCalendar').timeBased().everyMinutes(10).create();
}

function deleteSyncTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'syncGroupMeToGoogleCalendar') ScriptApp.deleteTrigger(trigger);
  });
}

function fingerprint_(value) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(value),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function (byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); }).join('');
}

function redactToken_(text, token) {
  return String(text).split(String(token)).join('[REDACTED]');
}

function isNotFound_(error) {
  return /\b404\b|not found/i.test(String(error && error.message || error));
}
