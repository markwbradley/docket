/* Docket calendar feed.

   Runs in your own Google account and gives Docket the coming week's
   appointments from the calendars listed below. It only reads; it never
   changes anything in your calendar. Docket's Worker asks for the feed
   with a key that only you and the Worker know.

   Set-up, about five minutes:
   1. Go to script.google.com and press New project. Delete what is in the
      editor and paste in this whole file. Name the project "Docket calendar".
   2. In CALENDARS below, put your two calendars. 'primary' is your main
      calendar. For another, use its name exactly as Google Calendar shows
      it under "My calendars". The label is what Docket shows on each
      appointment.
   3. Save, choose "setup" in the function menu at the top, and press Run.
      Google asks for permission: choose your account, then Advanced, then
      "Go to Docket calendar", then Allow. The log at the bottom shows your
      key, every calendar the script can see, and whether it found yours.
   4. Deploy > New deployment. Click the cog next to "Select type" and choose
      Web app. Execute as: Me. Who has access: Anyone. Press Deploy and copy
      the Web app URL (it ends in /exec).
   5. In Cloudflare: Workers & Pages > docket > Settings > Variables and
      Secrets. Add two secrets: GCAL_URL (the Web app URL) and GCAL_KEY (the
      key from step 3). Docket shows appointments from its next refresh.

   If you change CALENDARS later: Deploy > Manage deployments > edit (the
   pencil) > Version: New version > Deploy. The URL stays the same. */

var CALENDARS = [
  { name: 'primary', label: 'Personal' },
  { name: 'Name of your second calendar', label: 'Work' }
];

var TZ = 'Europe/London';

function doGet(e) {
  var p = (e && e.parameter) || {};
  var key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key || p.key !== key) return out_({ error: 'forbidden' });
  var days = Math.max(1, Math.min(14, Number(p.days) || 8));
  var from = new Date(Date.now() - 24 * 3600 * 1000);
  var to = new Date(Date.now() + days * 24 * 3600 * 1000);
  var zone = Session.getScriptTimeZone();
  var events = [], missing = [];
  CALENDARS.forEach(function (c) {
    var cal = find_(c.name);
    if (!cal) { missing.push(c.name); return; }
    cal.getEvents(from, to).forEach(function (ev) {
      var mine = null;
      try { mine = ev.getMyStatus(); } catch (x) { }
      if (mine === CalendarApp.GuestStatus.NO) return;
      var allDay = ev.isAllDayEvent();
      events.push({
        id: ev.getId() + '@' + ev.getStartTime().getTime(),
        cal: c.label || cal.getName(),
        title: ev.getTitle() || '(No title)',
        location: ev.getLocation() || '',
        allDay: allDay,
        start: allDay ? Utilities.formatDate(ev.getAllDayStartDate(), zone, 'yyyy-MM-dd') : Utilities.formatDate(ev.getStartTime(), TZ, "yyyy-MM-dd'T'HH:mm:ss"),
        end: allDay ? Utilities.formatDate(ev.getAllDayEndDate(), zone, 'yyyy-MM-dd') : Utilities.formatDate(ev.getEndTime(), TZ, "yyyy-MM-dd'T'HH:mm:ss")
      });
    });
  });
  return out_({ events: events, missing: missing });
}

/* Run once from the editor. Makes the key (or shows the one already made),
   and checks the calendars above can be found. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('KEY', key);
  }
  Logger.log('GCAL_KEY for Cloudflare: ' + key);
  Logger.log('Calendars this account can see: ' + CalendarApp.getAllCalendars().map(function (c) { return c.getName(); }).join('  |  '));
  CALENDARS.forEach(function (c) { Logger.log((find_(c.name) ? 'Found: ' : 'NOT FOUND: ') + c.name); });
}

function find_(name) {
  if (name === 'primary') return CalendarApp.getDefaultCalendar();
  var byName = CalendarApp.getCalendarsByName(name);
  if (byName && byName.length) return byName[0];
  try { return CalendarApp.getCalendarById(name); } catch (x) { return null; }
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
