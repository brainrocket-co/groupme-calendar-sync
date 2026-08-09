# GroupMe → Google Calendar sync

A small, one-way mirror for a GroupMe group's upcoming Events. GroupMe remains the place to create, edit, cancel, and RSVP; a dedicated Google Calendar makes those events visible in everyone's normal calendar apps.

Mirrored descriptions include GroupMe's optional event-detail links, capacity,
and an informational RSVP summary with GroupMe display names. The Google event
links back to GroupMe for responding; it does not create Google attendees or
send Google invitations. Unknown future event-detail types are displayed rather
than discarded.

## Minimal design

```text
GroupMe Event (source of truth)
        ↓ every 10 minutes
Google Apps Script
        ↓ create / update / delete
Roadie Google Calendar (mirror)
```

The script stores the GroupMe token, group ID, and calendar ID in **Apps Script Properties**, not in this repository. It stores the GroupMe-to-Google event mapping there too. A script lock prevents overlapping runs.

Important: GroupMe's calendar endpoint is community-documented, not part of its official public API. GroupMe could change it without notice. To limit damage, the script skips deletions whenever a response reaches the configured fetch limit, since that may mean the list was truncated.

## Repository layout

- `src/Code.js` — sync and trigger functions
- `src/appsscript.json` — Apps Script manifest and permissions
- `test/sync.test.js` — local tests for response conversion
- `.clasp.json.example` — optional local-to-Apps-Script setup

## 1. Prepare GroupMe

1. Sign in at [GroupMe Developers](https://dev.groupme.com/) and copy your access token. Treat it like a password.
2. Find the numeric ID of the Roadie group. One easy method is to call GroupMe's official groups endpoint while authenticated and locate the group by name:
   `https://api.groupme.com/v3/groups?token=YOUR_TOKEN`
3. Do not put the token into a file, commit, issue, screenshot, or chat message.

## 2. Prepare Google Calendar

1. In Google Calendar, create a separate calendar such as **Roadie Crew**.
2. Open that calendar's **Settings and sharing** page.
3. Under **Integrate calendar**, copy the **Calendar ID**.
4. Share the calendar read-only with the Roadies now or after testing.

## 3. Create the Apps Script project

The simplest first setup is manual:

1. Go to [script.google.com](https://script.google.com/) and create a new project named `GroupMe Calendar Sync`.
2. Replace the editor's starter code with the contents of `src/Code.js`.
3. In **Project Settings**, enable **Show “appsscript.json” manifest file in editor**.
4. Replace that manifest with `src/appsscript.json`.
5. In **Project Settings → Script Properties**, add exactly:

   - `GROUPME_TOKEN` — your private GroupMe access token
   - `GROUPME_GROUP_ID` — the Roadie GroupMe group ID
   - `GOOGLE_CALENDAR_ID` — the dedicated Google Calendar ID

The manifest enables the Advanced Calendar service. If Apps Script still prompts for it, open **Services (+)** and add **Google Calendar API**.

## 4. Test safely

Use a temporary Google calendar and a GroupMe test event first.

1. Create a GroupMe Event at least a few minutes in the future.
2. In Apps Script, select `syncGroupMeToGoogleCalendar` and click **Run**.
3. Approve the requested GroupMe network and Google Calendar permissions.
4. Confirm the event appears on the temporary calendar with the correct title, time, description, and location.
5. Edit the GroupMe event, run again, and confirm the same Google event changes rather than duplicating.
6. Delete the GroupMe event, run again, and confirm the mirrored event disappears.
7. Review **Executions** and confirm the run completed successfully.

### Inspect GroupMe's current event fields

GroupMe's Events API is undocumented and its newer fields may change. To inspect
one real event safely, run `inspectLatestGroupMeEventPayload` manually in Apps
Script and open the execution log. It fetches the first upcoming event from both
the list and event-details endpoints. The diagnostic output does not include the
GroupMe token or Google Calendar ID, but it can include event text and member
IDs, so review it before sharing it publicly.

To test the pure conversion code locally (Node 18 or newer):

```sh
npm test
```

## 5. Turn on automatic sync

Run `createSyncTrigger` once in Apps Script and approve access. It removes any duplicate sync triggers and creates one that runs every 10 minutes. The trigger runs as the Google account that created it, so that account must retain write access to the calendar.

Ten minutes is the recommended interval for this project: it keeps RSVP and
schedule changes reasonably fresh while remaining tiny compared with Apps
Script's normal quotas. Unchanged events are skipped, so frequent polling does
not repeatedly rewrite Google Calendar events.

To stop automatic syncing, run `deleteSyncTriggers`.

## Optional local deployment with clasp

This repository is already hosted at
[`brainrocket-co/groupme-calendar-sync`](https://github.com/brainrocket-co/groupme-calendar-sync).
To deploy from a local checkout, install Google's `clasp`, copy
`.clasp.json.example` to `.clasp.json`, enter the Apps Script project ID, sign
in, and use `clasp push`. The project-specific `.clasp.json` is deliberately
ignored. Never commit the GroupMe token or other Script Properties.

## Current limitations

- Only upcoming events returned by GroupMe are mirrored; past events are left in Google Calendar.
- The GroupMe endpoint is unsupported and may change.
- RSVPs are a periodic snapshot; changes appear after the next sync rather than instantly.
- If GroupMe returns 100 events, deletion is skipped for that run to protect against an incomplete result set.
- Restoring or replacing the Apps Script project loses its private event mapping; existing mirror events may then duplicate on the first run.
