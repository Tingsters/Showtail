(function () {
  var sel = document.getElementById('st-tz');
  if (!sel) return;
  var local = 'UTC';
  try {
    local = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (e) {}
  var zones = null;
  try {
    if (typeof Intl.supportedValuesOf === 'function')
      zones = Intl.supportedValuesOf('timeZone');
  } catch (e) {
    zones = null;
  }
  if (!zones || !zones.length) {
    zones = [
      'UTC',
      'America/Los_Angeles',
      'America/Denver',
      'America/Chicago',
      'America/New_York',
      'America/Sao_Paulo',
      'Europe/London',
      'Europe/Paris',
      'Europe/Moscow',
      'Asia/Dubai',
      'Asia/Kolkata',
      'Asia/Shanghai',
      'Asia/Tokyo',
      'Australia/Sydney',
    ];
  }
  if (zones.indexOf(local) === -1) zones = [local].concat(zones);
  var saved = null;
  try {
    saved = localStorage.getItem('showtail-tz');
  } catch (e) {}
  var current = saved && zones.indexOf(saved) !== -1 ? saved : local;
  // The short code (e.g. PDT) plus the numeric GMT offset (e.g. GMT-7), both
  // derived from Intl; they collapse to one when the abbreviation is the offset.
  function zonePart(tz, type) {
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: type,
      }).formatToParts(new Date());
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'timeZoneName') return parts[i].value;
      }
    } catch (e) {}
    return '';
  }
  function zoneLabel(tz) {
    var name = zonePart(tz, 'short');
    var offset = zonePart(tz, 'shortOffset');
    if (name && offset && name !== offset) return tz + ' (' + name + ', ' + offset + ')';
    var code = offset || name;
    return code ? tz + ' (' + code + ')' : tz;
  }
  for (var i = 0; i < zones.length; i++) {
    var o = document.createElement('option');
    o.value = zones[i];
    o.textContent = zoneLabel(zones[i]);
    if (zones[i] === current) o.selected = true;
    sel.appendChild(o);
  }
  function render(tz) {
    // "20 Jun 2026, 14:30" — day-first, spelled month, 24-hour, no zone code
    // (the bar above already states the zone). Two formatters so the join is
    // exact regardless of locale quirks.
    var dateFmt, timeFmt;
    try {
      dateFmt = new Intl.DateTimeFormat('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: tz,
      });
      timeFmt = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: tz,
      });
    } catch (e) {
      return;
    }
    var nodes = document.querySelectorAll('time.st-time');
    for (var i = 0; i < nodes.length; i++) {
      var d = new Date(nodes[i].getAttribute('datetime'));
      if (!isNaN(d.getTime()))
        nodes[i].textContent = dateFmt.format(d) + ', ' + timeFmt.format(d);
    }
  }
  sel.addEventListener('change', function () {
    try {
      localStorage.setItem('showtail-tz', sel.value);
    } catch (e) {}
    render(sel.value);
  });
  render(current);
})();
