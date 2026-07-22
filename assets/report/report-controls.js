(function () {
  // Exchanges toolbar. Everything here is progressive enhancement: the bar is
  // rendered hidden and only revealed once this runs, so a no-JS reader never sees
  // dead controls — the report still reads top-to-bottom in chronological order.
  var bar = document.querySelector('.st-exbar');
  var list = document.getElementById('st-exchanges');
  if (!bar || !list) return;
  bar.removeAttribute('hidden');

  function save(key, val) {
    try {
      localStorage.setItem(key, val);
    } catch (e) {}
  }
  function load(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  // --- AI messages: show/hide every per-prompt pill at once ---
  var ai = document.getElementById('st-ai');
  if (ai) {
    var AI_KEY = 'showtail-show-ai';
    var savedAi = load(AI_KEY);
    if (savedAi === '1' || savedAi === '0') ai.checked = savedAi === '1';
    var applyAi = function (on) {
      var pills = document.querySelectorAll('details.ai-process');
      for (var i = 0; i < pills.length; i++) pills[i].open = on;
    };
    applyAi(ai.checked);
    ai.addEventListener('change', function () {
      save(AI_KEY, ai.checked ? '1' : '0');
      applyAi(ai.checked);
    });
  }

  // --- Expand / collapse all turns ---
  var expandBtn = document.getElementById('st-expand');
  if (expandBtn) {
    var expandLabel = expandBtn.querySelector('.st-btn-label');
    var setExpanded = function (on) {
      var turns = list.querySelectorAll('details.turn');
      for (var i = 0; i < turns.length; i++) turns[i].open = on;
      expandBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (expandLabel) expandLabel.textContent = on ? 'Collapse all' : 'Expand all';
    };
    expandBtn.addEventListener('click', function () {
      setExpanded(expandBtn.getAttribute('aria-pressed') !== 'true');
    });
  }

  // --- Sort: Time | Session, with a direction caret (re-click active to reverse) ---
  var sort = document.getElementById('st-sort');
  if (sort) {
    var SORT_KEY = 'showtail-sort';
    var btns = sort.querySelectorAll('.st-seg-btn');

    var tsOf = function (el) {
      return el.getAttribute('data-ts') || '';
    };
    var byTs = function (a, b) {
      var x = tsOf(a),
        y = tsOf(b);
      return x < y ? -1 : x > y ? 1 : 0;
    };
    var turnsArray = function () {
      var out = [],
        nodes = list.querySelectorAll('details.turn');
      for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
      return out;
    };
    var clearSeps = function () {
      var seps = list.querySelectorAll('.st-session-sep');
      for (var i = 0; i < seps.length; i++) seps[i].parentNode.removeChild(seps[i]);
    };
    var makeSep = function (group) {
      var first = group[0];
      var tool = first.getAttribute('data-tool') || '';
      var toolEl = tool ? first.querySelector('.badge--' + tool) : null;
      var toolName = toolEl ? toolEl.textContent : tool;
      var timeEl = first.querySelector('time.st-time');
      var when = timeEl ? timeEl.textContent : '';
      var n = group.length;
      var sep = document.createElement('div');
      sep.className = 'st-session-sep';
      sep.textContent =
        'Session · ' +
        toolName +
        (when ? ' · ' + when : '') +
        ' · ' +
        n +
        ' exchange' +
        (n === 1 ? '' : 's');
      return sep;
    };

    var apply = function (mode, dir) {
      clearSeps();
      var turns = turnsArray();
      if (mode === 'session') {
        // Group by session; order groups by earliest timestamp; chronological within.
        var groups = {},
          order = [];
        for (var i = 0; i < turns.length; i++) {
          var s = turns[i].getAttribute('data-session') || '';
          if (!groups[s]) {
            groups[s] = [];
            order.push(s);
          }
          groups[s].push(turns[i]);
        }
        var minTs = function (s) {
          var m = null;
          for (var i = 0; i < groups[s].length; i++) {
            var t = tsOf(groups[s][i]);
            if (m === null || t < m) m = t;
          }
          return m || '';
        };
        order.sort(function (a, b) {
          var x = minTs(a),
            y = minTs(b);
          return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1);
        });
        for (var g = 0; g < order.length; g++) {
          var grp = groups[order[g]];
          grp.sort(byTs);
          list.appendChild(makeSep(grp));
          for (var j = 0; j < grp.length; j++) list.appendChild(grp[j]);
        }
      } else {
        turns.sort(byTs);
        if (dir === 'desc') turns.reverse();
        for (var k = 0; k < turns.length; k++) list.appendChild(turns[k]);
      }
    };

    var setActive = function (mode, dir) {
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        var isActive = b.getAttribute('data-mode') === mode;
        b.classList.toggle('is-active', isActive);
        if (isActive) b.setAttribute('data-dir', dir);
        var caret = b.querySelector('.st-caret');
        if (caret) {
          caret.textContent =
            (isActive ? dir : b.getAttribute('data-dir') || 'asc') === 'desc' ? '▼' : '▲';
        }
      }
      save(SORT_KEY, mode + '|' + dir);
      apply(mode, dir);
    };

    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener('click', function () {
          var mode = b.getAttribute('data-mode') || 'time';
          var dir = b.getAttribute('data-dir') || 'asc';
          // Re-clicking the already-active mode reverses direction (like a table header).
          if (b.classList.contains('is-active')) dir = dir === 'asc' ? 'desc' : 'asc';
          setActive(mode, dir);
        });
      })(btns[i]);
    }

    // Restore a saved sort; otherwise leave the server DOM order (Time, oldest-first).
    var savedSort = load(SORT_KEY);
    if (savedSort) {
      var parts = savedSort.split('|');
      if (parts.length === 2) setActive(parts[0], parts[1]);
    }
  }
})();
