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
    var seen = {};
    var stats = { fetched: fetched.events.length, created: 0, updated: 0, deleted: 0 };

    fetched.events.forEach(function (groupMeEvent) {
      var normalized = normalizeGroupMeEvent_(groupMeEvent);
      seen[normalized.groupMeEventId] = true;
      var googleEventId = state[normalized.groupMeEventId] && state[normalized.groupMeEventId].googleEventId;
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

function extractEvents_(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.events)) return payload.events;
  if (payload.response && Array.isArray(payload.response.events)) return payload.response.events;
  throw new Error('Unexpected GroupMe events response shape.');
}

function normalizeGroupMeEvent_(event) {
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
    description: String(event.description || ''),
    location: String(location.address || location.name || ''),
    start: start,
    end: end,
    allDay: allDay,
    timeZone: event.timezone || Session.getScriptTimeZone()
  };
  normalized.fingerprint = fingerprint_(normalized);
  return normalized;
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
    source: { title: 'GroupMe event', url: 'https://groupme.com/' }
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
