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

  // --- Long AI narration: clamp it, with the control *below* the text ---
  // Done here rather than in the markup so a reader without JavaScript sees
  // every message in full — nothing is ever hidden from them. Heights are read
  // for all blocks first and classes written afterwards, so ~600 elements cost
  // one layout pass instead of one each.
  if (list.getAttribute('data-ai-mode') !== 'full') {
    var blocks = list.querySelectorAll('.ai-block');
    var maxPx = 18 * 16; // matches .ai-block.is-clamped max-height
    var overflowing = [];
    for (var b = 0; b < blocks.length; b++) {
      if (blocks[b].scrollHeight > maxPx + 24) overflowing.push(blocks[b]);
    }
    for (var c = 0; c < overflowing.length; c++) {
      (function (block) {
        block.classList.add('is-clamped');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ai-more';
        btn.textContent = 'Show more';
        btn.setAttribute('aria-expanded', 'false');
        btn.addEventListener('click', function () {
          var clamped = block.classList.toggle('is-clamped');
          btn.textContent = clamped ? 'Show more' : 'Show less';
          btn.setAttribute('aria-expanded', clamped ? 'false' : 'true');
        });
        block.parentNode.insertBefore(btn, block.nextSibling);
      })(overflowing[c]);
    }
  }

  // --- AI messages: show or hide the narration outright ---
  var ai = document.getElementById('st-ai');
  if (ai) {
    // A new key on purpose: the old one's '0' meant "pills collapsed, preview
    // still visible", and reading that as "hide narration" would hide content
    // from returning readers who never asked for it.
    var AI_KEY = 'showtail-ai-visible';
    var savedAi = load(AI_KEY);
    if (savedAi === '1' || savedAi === '0') ai.checked = savedAi === '1';
    var applyAi = function (on) {
      list.classList.toggle('st-hide-ai', !on);
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
      // Read the label off the row itself. Scraping it out of the badge used to
      // work, but the badge is hidden on rows that repeat the one above, so the
      // lookup could miss and fall back to the raw id ("claude-code").
      var toolName = first.getAttribute('data-tool-label') || tool;
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

    // A tool/model badge is worth showing where it changes, so a row repeating
    // the row above it hides its own. That is a property of the order on
    // screen, not the order the document was written in — so it is recomputed
    // here after every reorder. Without this the marks stay as rendered and the
    // badges land on seemingly arbitrary rows once you sort.
    var markBadgeRuns = function () {
      var turns = list.querySelectorAll('details.turn');
      var prevTool = null,
        prevModels = null;
      for (var i = 0; i < turns.length; i++) {
        var t = turns[i];
        var tool = t.getAttribute('data-tool-label') || '';
        var models = t.getAttribute('data-models') || '';
        t.classList.toggle('is-repeat-tool', prevTool !== null && tool === prevTool);
        t.classList.toggle(
          'is-repeat-model',
          prevModels !== null && models === prevModels,
        );
        prevTool = tool;
        prevModels = models;
      }
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
        var firsts = [];
        for (var g = 0; g < order.length; g++) {
          var grp = groups[order[g]];
          grp.sort(byTs);
          list.appendChild(makeSep(grp));
          for (var j = 0; j < grp.length; j++) list.appendChild(grp[j]);
          firsts.push(grp[0]);
        }
        markBadgeRuns();
        // Each session block states its own tool, even when it follows a block
        // that used the same one — the run restarts at every separator.
        for (var f = 0; f < firsts.length; f++) {
          firsts[f].classList.remove('is-repeat-tool', 'is-repeat-model');
        }
      } else {
        turns.sort(byTs);
        if (dir === 'desc') turns.reverse();
        for (var k = 0; k < turns.length; k++) list.appendChild(turns[k]);
        markBadgeRuns();
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
