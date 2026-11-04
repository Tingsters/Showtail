(function (global) {
  'use strict';
  var READER_SIZE = 10,
    INDEX_SIZE = 25,
    ACTIVITY_SIZE = 20;
  function node(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }
  function button(label, className, action) {
    var element = node('button', className, label);
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
  }
  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }
  function size(bytes) {
    return bytes >= 1048576
      ? (bytes / 1048576).toFixed(1) + ' MiB'
      : Math.ceil(bytes / 1024) + ' KiB';
  }
  function start(config) {
    var root = config.root,
      manifest = config.manifest;
    if (!root || !manifest || manifest.viewerPayloadVersion !== 1)
      throw new Error('Unsupported report viewer data.');
    var allTurns = (manifest.turns || []).concat(manifest.unlinked || []);
    var turnById = new Map(
      allTurns.map(function (turn) {
        return [turn.id, turn];
      }),
    );
    var observationById = new Map(
      (manifest.observations || []).map(function (item) {
        return [item.id, item];
      }),
    );
    var plans = manifest.plans || [];
    var sessionRows =
      manifest.sessions ||
      Array.from(
        new Set(
          allTurns.map(function (turn) {
            return turn.sessionId;
          }),
        ),
      ).map(function (id, i) {
        var turns = allTurns.filter(function (turn) {
          return turn.sessionId === id;
        });
        return {
          id: id,
          label: 'Conversation ' + (i + 1),
          from: turns[0] && turns[0].timestamp,
          to: turns[turns.length - 1] && turns[turns.length - 1].timestamp,
          tool: turns[0] && turns[0].tool,
          authors: Array.from(
            new Set(
              turns.map(function (turn) {
                return turn.author;
              }),
            ),
          ),
          models: Array.from(
            new Set(
              turns.flatMap(function (turn) {
                return turn.models || [];
              }),
            ),
          ),
          turnIds: turns
            .filter(function (turn) {
              return !turn.unlinked;
            })
            .map(function (turn) {
              return turn.id;
            }),
          unlinkedIds: turns
            .filter(function (turn) {
              return turn.unlinked;
            })
            .map(function (turn) {
              return turn.id;
            }),
        };
      });
    var sessions = new Map(
      sessionRows.map(function (session) {
        return [session.id, session];
      }),
    );
    var state = {
      scope: 'overview',
      query: '',
      session: '',
      tool: '',
      author: '',
      file: '',
      from: '',
      until: '',
      sort: 'oldest',
      group: 'time',
      page: 0,
      selected: null,
      item: null,
      textPage: 0,
      textRef: null,
      showAi: manifest.aiMode !== 'off',
      aiMode: manifest.aiMode === 'full' ? 'full' : 'collapsed',
      search: null,
      searching: false,
      open: [],
      expanded: false,
    };
    var preferences = {},
      preferenceKey = 'showtail-reader-preferences-v1';
    try {
      preferences = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
    } catch (error) {}
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences))
      preferences = {};
    if (preferences.group === 'time' || preferences.group === 'session')
      state.group = preferences.group;
    if (preferences.sort === 'oldest' || preferences.sort === 'newest')
      state.sort = preferences.sort;
    var zone = typeof preferences.zone === 'string' ? preferences.zone : '';
    if (!zone)
      try {
        zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch (error) {}
    zone = zone || 'UTC';
    if (manifest.aiMode !== 'off' && typeof preferences.showAi === 'boolean')
      state.showAi = preferences.showAi;
    if (preferences.aiMode === 'full' || preferences.aiMode === 'collapsed')
      state.aiMode = preferences.aiMode;
    var formatter,
      dayFormatter,
      channel,
      ready,
      sequence = 0,
      disposed = false,
      renderEpoch = 0,
      queryEpoch = 0,
      searchTimer;
    var ownHashWrites = new Map(),
      frames = new Map(),
      currentRows = [],
      mountedItems = new Map(),
      viewPrefs = new Map(),
      textRequest = 0;
    function savePreferences() {
      try {
        localStorage.setItem(
          preferenceKey,
          JSON.stringify({
            zone: zone,
            showAi: state.showAi,
            aiMode: state.aiMode,
            group: state.group,
            sort: state.sort,
          }),
        );
      } catch (error) {}
    }
    function dateFormat() {
      try {
        formatter = new Intl.DateTimeFormat('en-GB', {
          timeZone: zone,
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        dayFormatter = new Intl.DateTimeFormat('en-GB', {
          timeZone: zone,
          day: '2-digit',
          month: 'long',
          year: 'numeric',
        });
      } catch (error) {
        zone = 'UTC';
        formatter = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'UTC',
          dateStyle: 'medium',
          timeStyle: 'short',
        });
        dayFormatter = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'UTC',
          dateStyle: 'long',
        });
      }
    }
    dateFormat();
    function formatted(value, day) {
      var date = new Date(value);
      return Number.isFinite(date.getTime())
        ? (day ? dayFormatter : formatter).format(date)
        : 'Time unavailable';
    }
    function timestamp(value) {
      var element = node('time', '', formatted(value));
      element.dateTime = String(value || '');
      element.dataset.stTime = 'true';
      return element;
    }
    function refreshTimes() {
      dateFormat();
      for (var element of app.querySelectorAll('[data-st-time]'))
        element.textContent = formatted(
          element.dateTime || element.dataset.timestamp,
          element.dataset.stTime === 'day',
        );
    }
    function rich(host, text, context) {
      var helper = global.ShowtailRichText || global.ShowtailReportRichText;
      if (helper && typeof helper.render === 'function') {
        try {
          var result = helper.render(text, {
            context: context,
            maxNodes: Math.max(
              1,
              Math.min(1500, 6500 - app.querySelectorAll('*').length),
            ),
          });
          if (result && result.nodeType) {
            host.classList.add('st-v-markdown');
            host.appendChild(result);
            return;
          }
        } catch (error) {}
      }
      host.appendChild(node('div', 'st-v-prose', text));
    }
    var app = node('section', 'st-v-app');
    app.setAttribute('aria-label', 'Report reader');
    document.body.classList.add('st-viewer-page');
    var layout = node('div', 'st-v-layout'),
      rail = node('nav', 'st-v-rail'),
      main = node('main', 'st-v-main');
    rail.setAttribute('aria-label', 'Report sections');
    var compact = node('details', 'st-v-menu'),
      compactSummary = node('summary', '', 'Report sections');
    compact.id = 'st-viewer-menu';
    compact.appendChild(compactSummary);
    var compactNav = node('nav', 'st-v-compact-nav');
    compactNav.setAttribute('aria-label', 'Report sections');
    compact.appendChild(compactNav);
    var sections = [
      ['overview', 'Overview'],
      ['plans', 'Plans'],
      ['sessions', 'Sessions'],
      ['prompts', 'Exchanges'],
      ['unlinked', 'Unlinked work'],
      ['observations', 'File observations'],
    ];
    var navButtons = [];
    sections.forEach(function (entry) {
      [rail, compactNav].forEach(function (host) {
        var item = button(entry[1], 'st-v-nav-link', function () {
          state.scope = entry[0];
          state.page = 0;
          state.selected = state.item = null;
          state.open = [];
          compact.open = false;
          render();
          writeHash();
        });
        item.dataset.scope = entry[0];
        host.appendChild(item);
        navButtons.push(item);
      });
    });
    var railTitle = node('p', 'st-v-rail-title', 'In this report');
    rail.prepend(railTitle);
    main.appendChild(compact);
    var controls = node('div', 'st-v-controls'),
      searchRow = node('div', 'st-v-search-row');
    var searchLabel = node('label', 'st-v-search-label', 'Search recorded content');
    searchLabel.htmlFor = 'st-viewer-search';
    var searchInput = node('input', 'st-v-search');
    searchInput.id = 'st-viewer-search';
    searchInput.type = 'search';
    searchInput.maxLength = 512;
    searchInput.placeholder = 'Search prompts, replies, plans, tools and diffs';
    searchRow.append(searchLabel, searchInput);
    var filterDisclosure = node('details', 'st-v-filter-disclosure');
    filterDisclosure.id = 'st-viewer-filters';
    filterDisclosure.appendChild(node('summary', '', 'Filters and display'));
    var filters = node('div', 'st-v-filters');
    filterDisclosure.appendChild(filters);
    function select(label, id, options, changed) {
      var wrapper = node('label', 'st-v-filter-label', label),
        input = node('select');
      input.id = id;
      options.forEach(function (option) {
        var element = node('option', '', option[1]);
        element.value = option[0];
        input.appendChild(element);
      });
      input.addEventListener('change', function () {
        changed(input.value);
      });
      wrapper.appendChild(input);
      filters.appendChild(wrapper);
      return input;
    }
    var sessionSelect = select(
      'Conversation',
      'st-viewer-session',
      [['', 'All conversations']].concat(
        sessionRows.map(function (s) {
          return [s.id, s.label || s.id];
        }),
      ),
      function (value) {
        state.session = value;
        changedFilter();
      },
    );
    var toolSelect = select(
      'Tool',
      'st-viewer-tool',
      [['', 'All tools']].concat(
        Array.from(
          new Set(
            allTurns.map(function (turn) {
              return turn.tool;
            }),
          ),
        ).map(function (tool) {
          return [tool, tool];
        }),
      ),
      function (value) {
        state.tool = value;
        changedFilter();
      },
    );
    var authors = Array.from(
      new Set(
        allTurns.map(function (turn) {
          return turn.author;
        }),
      ),
    );
    var authorSelect =
      authors.length > 1
        ? select(
            'Contributor',
            'st-viewer-author',
            [['', 'All contributors']].concat(
              authors.map(function (author) {
                return [author, author];
              }),
            ),
            function (value) {
              state.author = value;
              changedFilter();
            },
          )
        : null;
    var sortSelect = select(
      'Order',
      'st-viewer-sort',
      [
        ['oldest', 'Oldest first'],
        ['newest', 'Newest first'],
      ],
      function (value) {
        state.sort = value;
        savePreferences();
        changedFilter();
      },
    );
    var groupSelect = select(
      'Group exchanges',
      'st-viewer-group',
      [
        ['session', 'Conversation'],
        ['time', 'Date'],
      ],
      function (value) {
        state.group = value;
        savePreferences();
        render();
        writeHash();
      },
    );
    function inputFilter(label, id, type, key) {
      var wrapper = node('label', 'st-v-filter-label', label),
        input = node('input');
      input.type = type;
      input.id = id;
      input.addEventListener(type === 'date' ? 'change' : 'input', function () {
        state[key] = input.value;
        changedFilter();
      });
      wrapper.appendChild(input);
      filters.appendChild(wrapper);
      return input;
    }
    var fileInput = inputFilter('File path', 'st-viewer-file', 'search', 'file');
    var fromInput = inputFilter('From (UTC date)', 'st-viewer-from', 'date', 'from'),
      untilInput = inputFilter('Through (UTC date)', 'st-viewer-until', 'date', 'until');
    var zoneSelect = select(
      'Display timezone',
      'st-viewer-zone',
      [
        [zone, zone],
        ['UTC', 'UTC'],
      ].filter(function (entry, i, array) {
        return (
          array.findIndex(function (other) {
            return other[0] === entry[0];
          }) === i
        );
      }),
      function (value) {
        zone = value;
        refreshTimes();
        if (state.group === 'time') render();
        savePreferences();
      },
    );
    zoneSelect.value = zone;
    var zonesLoaded = false;
    zoneSelect.addEventListener('focus', function () {
      if (zonesLoaded) return;
      zonesLoaded = true;
      try {
        if (Intl.supportedValuesOf)
          Intl.supportedValuesOf('timeZone').forEach(function (value) {
            if (
              Array.from(zoneSelect.options).some(function (o) {
                return o.value === value;
              })
            )
              return;
            var option = node('option', '', value);
            option.value = value;
            zoneSelect.appendChild(option);
          });
      } catch (error) {}
    });
    var aiLabel = node('label', 'st-v-check'),
      aiInput = node('input');
    aiInput.type = 'checkbox';
    aiInput.id = 'st-viewer-ai';
    aiInput.checked = state.showAi;
    aiInput.disabled = manifest.aiMode === 'off';
    aiLabel.append(
      aiInput,
      document.createTextNode(
        manifest.aiMode === 'off'
          ? 'AI text omitted from this report'
          : 'Show AI responses',
      ),
    );
    filters.appendChild(aiLabel);
    aiInput.addEventListener('change', function () {
      state.showAi = aiInput.checked;
      savePreferences();
      render();
      writeHash();
    });
    var aiModeSelect = select(
      'AI response display',
      'st-viewer-ai-mode',
      [
        ['full', 'Expanded'],
        ['collapsed', 'Collapsed'],
      ],
      function (value) {
        state.aiMode = value;
        savePreferences();
        render();
      },
    );
    aiModeSelect.value = state.aiMode;
    aiModeSelect.disabled = manifest.aiMode === 'off';
    filters.appendChild(
      button('Reset filters', '', function () {
        state.session =
          state.tool =
          state.author =
          state.file =
          state.from =
          state.until =
            '';
        state.sort = 'oldest';
        syncControls();
        changedFilter();
      }),
    );
    controls.append(searchRow, filterDisclosure);
    main.appendChild(controls);
    var status = node('div', 'st-v-status');
    status.id = 'st-viewer-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    main.appendChild(status);
    var reader = node('div', 'st-v-reader');
    reader.id = 'st-viewer-reader';
    main.appendChild(reader);
    layout.append(rail, main);
    app.appendChild(layout);
    root.replaceChildren(app);
    function setStatus(message, error) {
      status.textContent = message;
      status.classList.toggle('is-error', !!error);
    }
    function createChannel(fallback) {
      var pending = new Map(),
        worker,
        engine,
        blobUrl,
        closed = false;
      function post(message) {
        if (closed) return;
        if (worker) {
          try {
            worker.postMessage(message);
          } catch (error) {
            recoverWorker();
          }
        } else
          queueMicrotask(function () {
            if (!closed) engine.handle(message);
          });
      }
      function mainThreadEngine() {
        if (!global.ShowtailReportWorker)
          throw new Error(
            'This browser cannot start the report viewer. The overview remains available.',
          );
        engine = global.ShowtailReportWorker.create(function (message) {
          queueMicrotask(function () {
            incoming(message);
          });
        });
      }
      function recoverWorker() {
        if (closed || !worker) return;
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        worker.terminate();
        worker = null;
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        blobUrl = null;
        try {
          mainThreadEngine();
          // Worker startup may fail asynchronously, including after init has
          // replied. Seed the same engine and replay only unfinished requests.
          engine.handle({ type: 'init', id: 0, manifest: manifest });
          app.dataset.runtime = 'main-thread';
          for (var request of pending.values()) post(request.message);
        } catch (error) {
          closed = true;
          for (var request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
          }
          pending.clear();
        }
      }
      function incoming(message) {
        if (message.type === 'needChunk') {
          Promise.resolve()
            .then(function () {
              return config.getChunk(message.chunk);
            })
            .then(
              function (data) {
                post({ type: 'chunk', chunk: message.chunk, data: data });
              },
              function () {
                post({
                  type: 'chunk',
                  chunk: message.chunk,
                  error: 'The embedded content chunk is unavailable.',
                });
              },
            );
          return;
        }
        var request = pending.get(message.id);
        if (!request) return;
        if (message.progress) {
          if (request.progress) request.progress(message.result);
          return;
        }
        clearTimeout(request.timer);
        pending.delete(message.id);
        if (message.ok) request.resolve(message.result);
        else
          request.reject(new Error(String(message.error || 'Report operation failed.')));
      }
      if (!fallback && typeof Worker === 'function') {
        try {
          blobUrl = URL.createObjectURL(
            new Blob([config.workerSource], { type: 'application/javascript' }),
          );
          worker = new Worker(blobUrl);
          worker.onmessage = function (event) {
            incoming(event.data);
          };
          worker.onerror = function (event) {
            event.preventDefault();
            recoverWorker();
          };
          worker.onmessageerror = recoverWorker;
        } catch (error) {
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          worker = null;
        }
      }
      if (!worker) {
        mainThreadEngine();
      }
      return {
        get mode() {
          return worker ? 'worker' : 'main-thread';
        },
        call: function (type, data, progress) {
          return new Promise(function (resolve, reject) {
            if (closed) {
              reject(new Error('The report worker is no longer available.'));
              return;
            }
            var id = ++sequence,
              timer = setTimeout(
                function () {
                  pending.delete(id);
                  reject(
                    new Error(
                      'This report operation timed out. Select another item or retry the search.',
                    ),
                  );
                },
                type === 'search' ? 120000 : 30000,
              );
            var message = Object.assign({ type: type, id: id }, data);
            pending.set(id, {
              resolve: resolve,
              reject: reject,
              progress: progress,
              timer: timer,
              message: message,
            });
            post(message);
          });
        },
        close: function () {
          closed = true;
          if (worker) worker.terminate();
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          for (var entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(new Error('Viewer closed.'));
          }
          pending.clear();
        },
      };
    }

    function resolveItem(id) {
      var seen = new Set();
      while (id && own(manifest.aliases, id) && !seen.has(id)) {
        seen.add(id);
        id = manifest.aliases[id];
      }
      return id;
    }
    function scopeRows() {
      return state.scope === 'prompts'
        ? manifest.turns
        : state.scope === 'unlinked'
          ? manifest.unlinked
          : state.scope === 'observations'
            ? manifest.observations
            : state.scope === 'plans'
              ? plans
              : state.scope === 'sessions'
                ? sessionRows
                : [];
    }
    function filteredRows() {
      var matchIds =
        state.query && state.search && state.search.matches
          ? state.search.matches[state.scope] || []
          : null;
      var matchingTurns =
        state.query && state.search
          ? new Set(
              (state.search.matches.prompts || []).concat(
                state.search.matches.unlinked || [],
              ),
            )
          : null;
      var lowerFile = state.file.toLowerCase(),
        query = state.query.toLowerCase();
      return scopeRows()
        .filter(function (row) {
          if (state.scope === 'sessions') {
            if (state.session && row.id !== state.session) return false;
            if (state.tool && row.tool !== state.tool) return false;
            if (state.author && !(row.authors || []).includes(state.author)) return false;
            if (
              query &&
              !String(row.label + ' ' + row.id + ' ' + (row.models || []).join(' '))
                .toLowerCase()
                .includes(query) &&
              !(row.turnIds || []).concat(row.unlinkedIds || []).some(function (id) {
                return matchingTurns && matchingTurns.has(id);
              })
            )
              return false;
          } else {
            var owner = turnById.get(row.turnId);
            if (
              state.session &&
              (row.sessionId || (owner && owner.sessionId)) !== state.session
            )
              return false;
            if (state.tool && (row.tool || (owner && owner.tool)) !== state.tool)
              return false;
            if (state.author && (row.author || (owner && owner.author)) !== state.author)
              return false;
            if (
              query &&
              state.search &&
              !matchIds.includes(row.id) &&
              !(state.scope === 'plans' && matchingTurns && matchingTurns.has(row.turnId))
            )
              return false;
          }
          var files = row.files || (row.path ? [row.path] : []);
          if (
            lowerFile &&
            !files.some(function (path) {
              return path.toLowerCase().includes(lowerFile);
            })
          )
            return false;
          var date = String(row.timestamp || row.from || '').slice(0, 10);
          return (
            (!state.from || date >= state.from) && (!state.until || date <= state.until)
          );
        })
        .sort(function (a, b) {
          if (
            state.group === 'session' &&
            (state.scope === 'prompts' || state.scope === 'unlinked') &&
            a.sessionId !== b.sessionId
          ) {
            var aSession = sessions.get(a.sessionId),
              bSession = sessions.get(b.sessionId);
            var sessionOrder = String(
              (aSession && aSession.from) || a.sessionId,
            ).localeCompare(String((bSession && bSession.from) || b.sessionId));
            if (sessionOrder)
              return state.sort === 'newest' ? -sessionOrder : sessionOrder;
          }
          var result = String(a.timestamp || a.from || '').localeCompare(
            String(b.timestamp || b.from || ''),
          );
          return state.sort === 'newest' ? -result : result;
        });
    }
    function pager(host, total, page, perPage, changed, prefix) {
      var pages = Math.max(1, Math.ceil(total / perPage)),
        wrapper = node('div', 'st-v-pager');
      var previous = button('Previous', '', function () {
          changed(page - 1);
        }),
        next = button('Next', '', function () {
          changed(page + 1);
        });
      previous.id = prefix + '-previous';
      next.id = prefix + '-next';
      previous.disabled = page <= 0;
      next.disabled = page + 1 >= pages;
      wrapper.append(
        previous,
        node(
          'span',
          '',
          'Page ' + (page + 1) + ' of ' + pages + ' · ' + total + ' entries',
        ),
        next,
      );
      host.appendChild(wrapper);
      return wrapper;
    }
    function badge(host, text, className) {
      if (text === undefined || text === null || text === '') return;
      host.appendChild(
        node('span', 'st-v-badge' + (className ? ' ' + className : ''), text),
      );
    }
    function metric(host, label, value, format) {
      var row = node('div', 'st-v-metric');
      row.dataset.metric = label;
      row.dataset.available = String(value !== null && value !== undefined);
      var keys = [
        ['Duration', 'durationMs'],
        ['AI working time (reported sum)', 'durationMs'],
        ['Input tokens', 'inputTokens'],
        ['Output tokens', 'outputTokens'],
        ['Cache read tokens', 'cacheReadTokens'],
        ['Cache creation tokens', 'cacheCreationTokens'],
      ];
      var key = keys.find(function (entry) {
        return entry[0] === label;
      });
      if (key) row.dataset.stat = key[1];
      row.append(
        node('dt', '', label),
        node(
          'dd',
          '',
          value === null || value === undefined
            ? 'Not captured'
            : format
              ? format(value)
              : Number(value).toLocaleString(),
        ),
      );
      host.appendChild(row);
    }
    function duration(value) {
      if (value >= 3600000)
        return (
          Math.floor(value / 3600000) +
          ' h ' +
          Math.round((value % 3600000) / 60000) +
          ' min'
        );
      return value < 1000
        ? value + ' ms'
        : value < 60000
          ? (value / 1000).toFixed(1) + ' s'
          : (value / 60000).toFixed(1) + ' min';
    }
    function usage(host, value, className) {
      if (!value) return;
      var stats = node('dl', 'st-v-stats' + (className ? ' ' + className : ''));
      stats.dataset.stats = className === 'st-v-report-stats' ? 'report' : 'session';
      metric(stats, 'AI working time (reported sum)', value.totalDurationMs, duration);
      metric(stats, 'Input tokens', value.totalInputTokens);
      metric(stats, 'Output tokens', value.totalOutputTokens);
      metric(stats, 'Cache read tokens', value.totalCacheReadTokens);
      metric(stats, 'Cache creation tokens', value.totalCacheCreationTokens);
      host.appendChild(stats);
      if (typeof value.recapCount === 'number')
        host.appendChild(
          node(
            'p',
            'st-v-note',
            'Duration captured for ' +
              value.durationCount +
              ' of ' +
              value.turnCount +
              ' exchanges; token usage for ' +
              value.tokenCount +
              ' of ' +
              value.turnCount +
              '. Missing usage is shown as not captured. Working time sums provider-reported durations; overlapping sessions can make this exceed elapsed time.',
          ),
        );
    }
    function filteredUsage() {
      var matching =
        state.query && state.search
          ? new Set(
              (state.search.matches.prompts || []).concat(
                state.search.matches.unlinked || [],
              ),
            )
          : null;
      var turns = allTurns.filter(function (turn) {
        return (
          (!state.session || turn.sessionId === state.session) &&
          (!state.tool || turn.tool === state.tool) &&
          (!state.author || turn.author === state.author) &&
          (!state.file ||
            turn.files.some(function (path) {
              return path.toLowerCase().includes(state.file.toLowerCase());
            })) &&
          (!state.from || turn.timestamp.slice(0, 10) >= state.from) &&
          (!state.until || turn.timestamp.slice(0, 10) <= state.until) &&
          (!matching || matching.has(turn.id))
        );
      });
      var result = {
        turnCount: turns.length,
        recapCount: 0,
        durationCount: 0,
        tokenCount: 0,
      };
      [
        ['durationMs', 'totalDurationMs'],
        ['inputTokens', 'totalInputTokens'],
        ['outputTokens', 'totalOutputTokens'],
        ['cacheReadTokens', 'totalCacheReadTokens'],
        ['cacheCreationTokens', 'totalCacheCreationTokens'],
      ].forEach(function (pair) {
        var values = turns
          .map(function (turn) {
            return turn.recap && turn.recap[pair[0]];
          })
          .filter(function (value) {
            return typeof value === 'number';
          });
        result[pair[1]] = values.length
          ? values.reduce(function (sum, value) {
              return sum + value;
            }, 0)
          : null;
      });
      turns.forEach(function (turn) {
        var recap = turn.recap;
        if (!recap) return;
        result.recapCount++;
        if (typeof recap.durationMs === 'number') result.durationCount++;
        if (
          ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'].some(
            function (field) {
              return typeof recap[field] === 'number';
            },
          )
        )
          result.tokenCount++;
      });
      return result;
    }
    function hasFilters() {
      return !!(
        state.query ||
        state.session ||
        state.tool ||
        state.author ||
        state.file ||
        state.from ||
        state.until
      );
    }
    function renderOverview() {
      var overview = node('section', 'st-v-overview');
      overview.id = 'st-viewer-overview';
      overview.dataset.section = 'overview';
      overview.appendChild(node('h2', '', 'Overview'));
      var summary = manifest.summary || {},
        stats = node('dl', 'st-v-stats');
      metric(stats, 'Exchanges', manifest.turns.length);
      metric(stats, 'Conversations', summary.sessions);
      metric(stats, 'Captured revisions', summary.artifacts);
      metric(
        stats,
        'Unique files',
        manifest.uniqueFileCount === undefined
          ? summary.fileGroups
          : manifest.uniqueFileCount,
      );
      metric(stats, 'Plans', plans.length);
      metric(stats, 'Decisions', summary.decisions);
      metric(stats, 'Redactions', manifest.redactionCount);
      overview.appendChild(stats);
      if (summary.plans !== undefined && summary.plans !== plans.length)
        overview.appendChild(
          node(
            'p',
            'st-v-note',
            plans.length +
              ' distinct plans from ' +
              summary.plans +
              ' captured plan records.',
          ),
        );
      usage(overview, manifest.usage || summary.stats, 'st-v-report-stats');
      if (hasFilters()) {
        overview.appendChild(node('h3', '', 'Current filtered selection'));
        usage(overview, filteredUsage(), 'st-v-filtered-stats');
      }
      if (manifest.coverage) {
        var coverage = node('section', 'st-v-coverage');
        coverage.appendChild(node('h3', '', 'Capture coverage'));
        badge(coverage, manifest.coverage.status || 'Unknown');
        if (manifest.coverage.meaning)
          coverage.appendChild(node('p', 'st-v-note', manifest.coverage.meaning));
        var sources = manifest.coverage.sources || [];
        if (sources.length) {
          var disclosure = node('details');
          disclosure.appendChild(
            node('summary', '', sources.length + ' source histories'),
          );
          var coveragePage = 0,
            coverageBody = node('div');
          disclosure.appendChild(coverageBody);
          function drawCoverage() {
            coverageBody.replaceChildren();
            pager(
              coverageBody,
              sources.length,
              coveragePage,
              INDEX_SIZE,
              function (page) {
                coveragePage = page;
                drawCoverage();
              },
              'st-viewer-coverage',
            );
            var list = node('ul');
            sources
              .slice(coveragePage * INDEX_SIZE, (coveragePage + 1) * INDEX_SIZE)
              .forEach(function (source) {
                list.appendChild(
                  node(
                    'li',
                    '',
                    [
                      source.sessionId,
                      source.status,
                      source.prompts === undefined ? '' : source.prompts + ' prompts',
                      source.missing ? source.missing + ' missing' : '',
                      (source.warningCodes || []).join(', '),
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  ),
                );
              });
            coverageBody.appendChild(list);
          }
          drawCoverage();
          coverage.appendChild(disclosure);
        }
        overview.appendChild(coverage);
      }
      if (manifest.scope)
        overview.appendChild(
          node(
            'p',
            'st-v-note',
            'Contributor scope: ' + (manifest.scope.name || manifest.scope.slug),
          ),
        );
      if (manifest.authorship)
        overview.appendChild(node('p', 'st-v-authorship', manifest.authorship));
      function table(title, rows, labelKeys, countKeys) {
        if (!rows || !rows.length) return;
        var section = node('section', 'st-v-overview-section');
        section.appendChild(node('h3', '', title));
        var list = node('ul', 'st-v-summary-list');
        rows.forEach(function (entry) {
          var label = labelKeys
            .map(function (key) {
              return entry[key];
            })
            .find(function (v) {
              return v !== undefined;
            });
          var count = countKeys
            .map(function (key) {
              return entry[key];
            })
            .find(function (v) {
              return v !== undefined;
            });
          list.appendChild(
            node(
              'li',
              '',
              String(label || 'Unknown') +
                (count === undefined ? '' : ' · ' + count + ' events') +
                (entry.artifacts === undefined
                  ? ''
                  : ' · ' + entry.artifacts + ' file records'),
            ),
          );
        });
        section.appendChild(list);
        overview.appendChild(section);
      }
      table(
        'Contributors',
        manifest.contributors,
        ['name', 'slug'],
        ['events', 'eventCount'],
      );
      table('Tools', manifest.tools, ['label', 'tool'], ['events', 'count']);
      table(
        'Models',
        manifest.models,
        ['label', 'model'],
        ['responses', 'events', 'count'],
      );
      if (manifest.toolTimeline && manifest.toolTimeline.length) {
        var chronology = node('details', 'st-v-tool-timeline');
        chronology.appendChild(
          node(
            'summary',
            '',
            'Tool chronology (' + manifest.toolTimeline.length + ' blocks)',
          ),
        );
        var timelinePage = 0,
          timelineBody = node('div');
        chronology.appendChild(timelineBody);
        function renderTimeline() {
          timelineBody.replaceChildren();
          pager(
            timelineBody,
            manifest.toolTimeline.length,
            timelinePage,
            INDEX_SIZE,
            function (page) {
              timelinePage = page;
              renderTimeline();
            },
            'st-viewer-tool-timeline',
          );
          var list = node('ol');
          manifest.toolTimeline
            .slice(timelinePage * INDEX_SIZE, (timelinePage + 1) * INDEX_SIZE)
            .forEach(function (block) {
              var li = node(
                'li',
                '',
                String(block.label || block.tool || 'Tool') + ' · ',
              );
              li.append(
                timestamp(block.from || block.start || block.timestamp),
                document.createTextNode(' – '),
                timestamp(block.to || block.from),
                document.createTextNode(' · ' + block.count + ' events'),
              );
              list.appendChild(li);
            });
          timelineBody.appendChild(list);
        }
        renderTimeline();
        overview.appendChild(chronology);
      }
      overview.appendChild(
        button('Read exchanges', 'st-v-primary', function () {
          state.scope = 'prompts';
          state.page = 0;
          render();
          writeHash();
        }),
      );
      reader.appendChild(overview);
    }
    function render() {
      var epoch = ++renderEpoch;
      mountedItems.clear();
      frames.clear();
      reader.replaceChildren();
      navButtons.forEach(function (entry) {
        entry.setAttribute(
          'aria-current',
          entry.dataset.scope === state.scope ? 'page' : 'false',
        );
      });
      if (state.scope === 'overview') {
        renderOverview();
        setStatus('Report overview.');
        return;
      }
      currentRows = filteredRows();
      var perPage =
        state.scope === 'prompts' || state.scope === 'unlinked'
          ? READER_SIZE
          : INDEX_SIZE;
      state.page = Math.max(
        0,
        Math.min(
          Number(state.page) || 0,
          Math.max(0, Math.ceil(currentRows.length / perPage) - 1),
        ),
      );
      var title = sections.find(function (entry) {
        return entry[0] === state.scope;
      });
      reader.appendChild(
        node('h2', 'st-v-section-title', title ? title[1] : 'Exchanges'),
      );
      var toolbar = node('div', 'st-v-reader-actions');
      var printNote = node(
        'p',
        'st-v-print-note',
        'Print includes this page and its open disclosures. Other pages and closed content remain in this offline report.',
      );
      reader.appendChild(printNote);
      if (hasFilters()) {
        var selectedUsage = node('details', 'st-v-selection-usage');
        selectedUsage.appendChild(
          node('summary', '', 'Usage for the filtered selection'),
        );
        usage(selectedUsage, filteredUsage(), 'st-v-filtered-stats');
        reader.appendChild(selectedUsage);
      }
      if (perPage === READER_SIZE) {
        var expand = button('Expand current page', '', function () {
          state.open = currentRows
            .slice(state.page * perPage, (state.page + 1) * perPage)
            .map(function (row) {
              return row.id;
            });
          state.expanded = true;
          render();
          writeHash();
        });
        expand.id = 'st-viewer-expand-page';
        toolbar.appendChild(expand);
        toolbar.appendChild(
          button('Collapse current page', '', function () {
            state.open = [];
            state.selected = state.item = null;
            state.expanded = false;
            render();
            writeHash();
          }),
        );
      }
      var print = button('Print current page', 'st-v-print', function () {
        global.print();
      });
      print.id = 'st-viewer-print-page';
      toolbar.appendChild(print);
      reader.appendChild(toolbar);
      function pageChange(value) {
        state.page = value;
        state.open = [];
        state.selected = state.item = null;
        state.expanded = false;
        render();
        writeHash();
        reader.scrollIntoView({ block: 'start' });
      }
      pager(
        reader,
        currentRows.length,
        state.page,
        perPage,
        pageChange,
        'st-viewer-list',
      );
      var list = node('ol', 'st-v-list');
      list.id = 'st-viewer-list';
      if (state.scope === 'plans') reader.id = 'st-viewer-plans';
      else reader.id = 'st-viewer-reader';
      reader.appendChild(list);
      var pageRows = currentRows.slice(state.page * perPage, (state.page + 1) * perPage),
        previousGroup = '';
      pageRows.forEach(function (row) {
        if (state.scope === 'prompts' || state.scope === 'unlinked') {
          var key =
            state.group === 'time' ? formatted(row.timestamp, true) : row.sessionId;
          if (key !== previousGroup) {
            var group = node('li', 'st-v-session-group');
            group.dataset.sessionId = row.sessionId;
            var session = sessions.get(row.sessionId);
            var day = node(
              'h3',
              'st-v-session-heading',
              state.group === 'time'
                ? formatted(row.timestamp, true)
                : session
                  ? session.label
                  : row.sessionId,
            );
            day.dataset.sessionId = row.sessionId;
            if (state.group === 'time') {
              day.dataset.stTime = 'day';
              day.dataset.timestamp = row.timestamp;
            }
            var subheading = node(
              'p',
              '',
              state.group === 'time'
                ? session
                  ? session.label
                  : row.sessionId
                : formatted(row.timestamp, true),
            );
            if (state.group === 'session') {
              subheading.dataset.stTime = 'day';
              subheading.dataset.timestamp = row.timestamp;
            }
            group.append(day, subheading);
            list.appendChild(group);
            previousGroup = key;
          }
          renderExchange(row, list, epoch);
        } else if (state.scope === 'sessions') renderSession(row, list);
        else renderIndexItem(row, list, epoch);
      });
      if (!pageRows.length)
        list.appendChild(
          node(
            'li',
            'st-v-empty',
            state.searching
              ? 'Searching recorded content…'
              : 'No entries match these filters.',
          ),
        );
      setStatus(
        currentRows.length +
          ' ' +
          (title ? title[1].toLowerCase() : 'entries') +
          (state.searching
            ? ' · Searching all recorded content…'
            : state.query
              ? ' matching “' + state.query + '”'
              : ''),
      );
    }
    function turnStats(turn, host, expanded) {
      var recap = turn.recap || {},
        info = node('div', 'st-v-turn-summary');
      info.dataset.turnStats = turn.id;
      if (!expanded) {
        (turn.models || []).forEach(function (model) {
          badge(info, model, 'is-model');
        });
        var signals = turn.signals || {};
        [
          ['decisions', 'decisions'],
          ['plansProposed', 'plans proposed'],
          ['plansRevised', 'plans revised'],
          ['failedTools', 'failed tools'],
        ].forEach(function (entry) {
          if (signals[entry[0]] > 0)
            badge(
              info,
              signals[entry[0]] + ' ' + entry[1],
              entry[0] === 'failedTools' ? 'is-error' : 'is-signal',
            );
        });
        if (turn.longTurn) badge(info, 'Long exchange', 'is-signal');
        host.appendChild(info);
        return;
      }
      info.dataset.stats = 'turn';
      if (recap.gitBranch) badge(info, 'Branch: ' + recap.gitBranch, 'is-branch');
      var metrics = node('span', 'st-v-turn-usage');
      [
        ['durationMs', 'AI working time (reported)', duration],
        ['inputTokens', 'Input tokens'],
        ['outputTokens', 'Output tokens'],
        ['cacheReadTokens', 'Cache read tokens'],
        ['cacheCreationTokens', 'Cache creation tokens'],
      ].forEach(function (entry) {
        var value = recap[entry[0]],
          span = node(
            'span',
            '',
            entry[1] +
              ': ' +
              (value === undefined || value === null
                ? 'Not captured'
                : entry[2]
                  ? entry[2](value)
                  : value.toLocaleString()),
          );
        span.dataset.stat = entry[0];
        span.dataset.available = String(value !== undefined && value !== null);
        metrics.appendChild(span);
      });
      info.appendChild(metrics);
      if (turn.toolSummary) {
        var summary = turn.toolSummary;
        if (typeof summary === 'string') badge(info, summary);
        else if (Array.isArray(summary))
          summary.forEach(function (entry) {
            badge(
              info,
              typeof entry === 'string'
                ? entry
                : (entry.name || entry.tool || 'Tool') + ' × ' + (entry.count || 1),
            );
          });
        else {
          if (summary.total !== undefined) badge(info, summary.total + ' tool calls');
          (summary.byTool || []).slice(0, 4).forEach(function (entry) {
            badge(info, entry.name + ' × ' + entry.count);
          });
          if (summary.failed !== undefined && summary.failed > 0)
            badge(info, summary.failed + ' failed', 'is-error');
        }
      }
      if (turn.longTurn) badge(info, 'Long exchange', 'is-signal');
      var signals = turn.signals || {};
      [
        ['decisions', 'decisions'],
        ['plansProposed', 'plans proposed'],
        ['plansRevised', 'plans revised'],
        ['failedTools', 'failed tools'],
      ].forEach(function (entry) {
        if (signals[entry[0]] > 0)
          badge(
            info,
            signals[entry[0]] + ' ' + entry[1],
            entry[0] === 'failedTools' ? 'is-error' : 'is-signal',
          );
      });
      host.appendChild(info);
    }
    function renderExchange(turn, list, epoch) {
      var li = node('li', 'st-v-exchange');
      li.dataset.turnId = turn.id;
      var heading = node('div', 'st-v-exchange-heading'),
        toggle = button(turn.preview || 'Captured work', 'st-v-open-turn', function () {
          if (state.open.includes(turn.id)) {
            state.open = state.open.filter(function (id) {
              return id !== turn.id;
            });
            if (state.selected === turn.id) state.selected = state.item = null;
          } else {
            state.open.push(turn.id);
            state.selected = turn.id;
            var hit = state.search && state.search.hits && state.search.hits[turn.id];
            state.item = (hit && hit.itemId) || null;
            state.textRef = (hit && hit.ref) || null;
            state.textPage = (hit && hit.page) || 0;
          }
          render();
          var openedFrame = frames.get(turn.id);
          if (openedFrame) openedFrame.host.focus({ preventScroll: true });
          writeHash();
        });
      toggle.dataset.turnId = turn.id;
      toggle.setAttribute('aria-expanded', String(state.open.includes(turn.id)));
      heading.appendChild(toggle);
      li.appendChild(heading);
      var meta = node('p', 'st-v-meta');
      meta.append(
        timestamp(turn.timestamp),
        document.createTextNode(
          ' · ' + turn.tool + (turn.author ? ' · ' + turn.author : ''),
        ),
      );
      li.appendChild(meta);
      turnStats(turn, li);
      if (state.search && state.search.snippets && state.search.snippets[turn.id])
        li.appendChild(node('p', 'st-v-search-snippet', state.search.snippets[turn.id]));
      list.appendChild(li);
      if (!state.open.includes(turn.id)) return;
      var detail = node('section', 'st-v-turn-detail');
      detail.dataset.turnDetail = turn.id;
      detail.tabIndex = -1;
      detail.setAttribute('aria-label', 'Exchange details');
      if (state.selected === turn.id) detail.id = 'st-viewer-detail';
      li.appendChild(detail);
      turnStats(turn, detail, true);
      var frame = Object.assign(
        {
          turn: turn,
          host: detail,
          epoch: epoch,
          page: 0,
          kind: 'all',
          file: '',
          tab: 'activity',
          items: [],
          request: 0,
        },
        viewPrefs.get(turn.id) || {},
      );
      frames.set(turn.id, frame);
      var promptSelected =
        state.selected === turn.id &&
        !state.item &&
        (!state.textRef || state.textRef === turn.promptRef);
      if (turn.promptRef) {
        var prompt = node('section', 'st-v-prompt');
        prompt.appendChild(node('h4', '', 'You'));
        detail.appendChild(prompt);
        renderText(prompt, turn.promptRef, null, {
          page: promptSelected ? state.textPage : 0,
          rich: true,
          primary: promptSelected,
          turnId: turn.id,
        });
      } else
        detail.appendChild(
          node(
            'p',
            'st-v-note',
            'This captured work has no linked human prompt. It is not counted as a human exchange.',
          ),
        );
      var tabs = node('div', 'st-v-tabs');
      [
        ['activity', 'Activity'],
        ['files', 'Files (' + turn.files.length + ')'],
      ].forEach(function (entry) {
        var tab = button(entry[1], '', function () {
          frame.tab = entry[0];
          frame.page = 0;
          frame.file = '';
          changeFrame(frame);
        });
        tab.dataset.tab = entry[0];
        tab.setAttribute('aria-pressed', String(entry[0] === frame.tab));
        tabs.appendChild(tab);
      });
      detail.appendChild(tabs);
      frame.tabs = tabs;
      var activity = node('div', 'st-v-activity');
      activity.dataset.turnActivity = turn.id;
      detail.appendChild(activity);
      frame.activity = activity;
      loadActivity(frame, state.selected === turn.id ? state.item : null);
      if (turn.recapRef && state.showAi) {
        var recap = node('details', 'st-v-recap');
        recap.appendChild(node('summary', '', 'End-of-exchange recap'));
        recap.addEventListener('toggle', function () {
          if (recap.open && !recap.dataset.loaded) {
            recap.dataset.loaded = 'true';
            var selected = state.selected === turn.id && state.textRef === turn.recapRef;
            renderText(recap, turn.recapRef, null, {
              rich: true,
              primary: selected,
              page: selected ? state.textPage : 0,
              turnId: turn.id,
            });
          }
        });
        detail.appendChild(recap);
        if (state.selected === turn.id && state.textRef === turn.recapRef)
          recap.open = true;
      }
    }
    async function pageItems(frame, target) {
      var request = {
        turnId: frame.turn.id,
        page: frame.page,
        showAi: state.showAi,
        kind: frame.tab === 'files' && !frame.file ? 'files' : frame.kind,
        filePath: frame.file || undefined,
        itemId: target || undefined,
        groupTools: true,
      };
      return channel.call('getTurnPage', request);
    }
    function changeFrame(frame) {
      state.selected = frame.turn.id;
      state.item = null;
      state.textRef = null;
      state.textPage = 0;
      loadActivity(frame);
      writeHash();
    }
    async function loadActivity(frame, target) {
      viewPrefs.set(frame.turn.id, {
        page: frame.page,
        kind: frame.kind,
        file: frame.file,
        tab: frame.tab,
      });
      var epoch = ++frame.request;
      frame.activity.replaceChildren(
        node('p', 'st-v-note', 'Loading recorded activity…'),
      );
      frame.tabs.querySelectorAll('button').forEach(function (tab) {
        tab.setAttribute('aria-pressed', String(tab.dataset.tab === frame.tab));
      });
      try {
        await ready;
        var result = await pageItems(frame, target);
        if (
          disposed ||
          frame.epoch !== renderEpoch ||
          epoch !== frame.request ||
          !frame.host.isConnected
        )
          return;
        var items = result.items || [],
          total = result.total === undefined ? items.length : result.total;
        if (result.kind === 'native') {
          frame.kind = 'native';
          frame.tab = 'activity';
        }
        frame.items = items;
        frame.page = result.page === undefined ? frame.page : result.page;
        items.forEach(function (item) {
          mountedItems.set(item.id, item);
        });
        frame.activity.replaceChildren();
        if (frame.tab === 'files') {
          var files = node('div', 'st-v-file-choices');
          files.id = state.selected === frame.turn.id ? 'st-viewer-files' : '';
          if (frame.file) {
            files.appendChild(
              button('All files', '', function () {
                frame.file = '';
                frame.kind = 'all';
                frame.page = 0;
                changeFrame(frame);
              }),
            );
            files.appendChild(node('strong', '', frame.file));
          } else
            (result.fileGroups || result.files || []).forEach(function (entry) {
              var path = typeof entry === 'string' ? entry : entry.path;
              var choose = button(
                path +
                  (entry.revisions === undefined
                    ? ''
                    : ' · ' + entry.revisions + ' revisions'),
                '',
                function () {
                  frame.file = path;
                  frame.kind = 'revision';
                  frame.page = 0;
                  changeFrame(frame);
                },
              );
              choose.dataset.filePath = path;
              files.appendChild(choose);
            });
          frame.activity.appendChild(files);
          if (!frame.file && !target) {
            pager(
              frame.activity,
              total,
              frame.page,
              ACTIVITY_SIZE,
              function (page) {
                frame.page = page;
                changeFrame(frame);
              },
              'st-viewer-files-' + frame.turn.id,
            );
            frame.activity.appendChild(
              node('p', 'st-v-note', 'Choose a file to read its captured revisions.'),
            );
            return;
          }
        }
        var filter = node('div', 'st-v-activity-tools');
        if (frame.tab !== 'files') {
          var label = node('label', 'st-v-filter-label', 'Activity type'),
            kind = node('select');
          [
            ['all', 'All activity'],
            ['ai', 'AI responses'],
            ['tool', 'Tools'],
            ['plan', 'Plans'],
            ['decision', 'Decisions'],
            ['revision', 'File revisions'],
            ['observation', 'Observations'],
            ['native', 'Native source records'],
          ].forEach(function (entry) {
            var option = node('option', '', entry[1]);
            option.value = entry[0];
            kind.appendChild(option);
          });
          kind.value = frame.kind;
          kind.addEventListener('change', function () {
            frame.kind = kind.value;
            frame.page = 0;
            changeFrame(frame);
          });
          label.appendChild(kind);
          filter.appendChild(label);
        }
        frame.activity.appendChild(filter);
        pager(
          frame.activity,
          total,
          frame.page,
          ACTIVITY_SIZE,
          function (page) {
            frame.page = page;
            changeFrame(frame);
          },
          state.selected === frame.turn.id
            ? 'st-viewer-activity'
            : 'st-viewer-activity-' + frame.turn.id,
        );
        var list = node('ol', 'st-v-activities');
        list.dataset.activityList = frame.turn.id;
        if (state.selected === frame.turn.id) list.id = 'st-viewer-activities';
        frame.activity.appendChild(list);
        var group = null;
        items.forEach(function (item) {
          if (item.kind === 'tool_group') {
            group = null;
            renderToolGroup(item, list, frame, target);
            return;
          }
          if (item.nativeOnly && frame.kind !== 'native') return;
          if (item.kind === 'ai' && !state.showAi) return;
          if (item.kind === 'tool' && !item.nativeOnly) {
            if (!group) {
              var li = node('li', 'st-v-tool-group');
              var disclosure = node('details');
              disclosure.appendChild(node('summary', '', 'Tool activity'));
              var rows = node('ol');
              disclosure.appendChild(rows);
              li.appendChild(disclosure);
              list.appendChild(li);
              group = {
                host: rows,
                detail: disclosure,
                summary: disclosure.firstChild,
                count: 0,
                failed: 0,
              };
            }
            group.count++;
            if (item.isError) group.failed++;
            group.summary.textContent =
              group.count +
              ' tool ' +
              (group.count === 1 ? 'call' : 'calls') +
              (group.failed ? ' · ' + group.failed + ' failed' : '');
            group.detail.classList.toggle('has-failures', group.failed > 0);
            if (item.isError || item.id === target) group.detail.open = true;
            renderActivityItem(item, group.host, frame, target);
          } else {
            group = null;
            renderActivityItem(item, list, frame, target);
          }
        });
        if (!items.length)
          list.appendChild(
            node('li', 'st-v-empty', 'No recorded activity in this view.'),
          );
        if (target) {
          var selected = items.find(function (item) {
            return item.id === resolveItem(target);
          });
          if (
            !selected &&
            result.selected &&
            !items.some(function (item) {
              return item.kind === 'tool_group' && item.selected;
            })
          ) {
            mountedItems.set(result.selected.id, result.selected);
            renderActivityItem(result.selected, list, frame, target);
          }
          requestAnimationFrame(function () {
            var destination = frame.host.querySelector(
              '[data-item-id="' + CSS.escape(resolveItem(target)) + '"]',
            );
            if (destination) {
              destination.focus({ preventScroll: true });
              destination.scrollIntoView({ block: 'center' });
            }
          });
        }
      } catch (error) {
        if (frame.host.isConnected && epoch === frame.request)
          frame.activity.replaceChildren(
            node(
              'p',
              'st-v-error',
              'This activity could not be opened: ' + error.message,
            ),
          );
      }
    }
    function renderToolGroup(item, host, frame, target) {
      var li = node('li', 'st-v-tool-group');
      li.dataset.groupId = item.id;
      var disclosure = node('details');
      if (item.failed) disclosure.classList.add('has-failures');
      var toolNames = item.toolNames || [];
      if (!Array.isArray(toolNames))
        toolNames = Object.keys(toolNames).map(function (name) {
          return { name: name, count: item.toolNames[name] };
        });
      var names = toolNames
        .map(function (entry) {
          return typeof entry === 'string'
            ? entry
            : (entry.name || entry.tool || 'Tool') +
                (entry.count ? ' × ' + entry.count : '');
        })
        .join(', ');
      disclosure.appendChild(
        node(
          'summary',
          '',
          item.count +
            ' tool calls' +
            (names ? ' · ' + names : '') +
            (item.failed ? ' · ' + item.failed + ' failed' : ''),
        ),
      );
      var body = node('div', 'st-v-tool-group-body');
      disclosure.appendChild(body);
      li.appendChild(disclosure);
      host.appendChild(li);
      var groupPage = item.selectedPage || 0,
        groupEpoch = 0;
      async function load() {
        var epoch = ++groupEpoch;
        var requestedTarget = target;
        target = null;
        body.replaceChildren(node('p', 'st-v-note', 'Loading tool calls…'));
        try {
          var result = await channel.call('getTurnPage', {
            turnId: frame.turn.id,
            groupId: item.id,
            page: groupPage,
            itemId: requestedTarget || undefined,
            showAi: state.showAi,
          });
          if (!li.isConnected || epoch !== groupEpoch) return;
          groupPage = result.page || 0;
          body.replaceChildren();
          pager(
            body,
            result.total,
            groupPage,
            ACTIVITY_SIZE,
            function (page) {
              groupPage = page;
              load();
            },
            'st-viewer-tool-group-' + item.id,
          );
          var rows = node('ol');
          body.appendChild(rows);
          (result.items || []).forEach(function (call) {
            mountedItems.set(call.id, call);
            renderActivityItem(call, rows, frame, requestedTarget);
          });
          if (requestedTarget)
            requestAnimationFrame(function () {
              var destination = rows.querySelector(
                '[data-item-id="' + CSS.escape(resolveItem(requestedTarget)) + '"]',
              );
              if (destination) {
                destination.focus({ preventScroll: true });
                destination.scrollIntoView({ block: 'center' });
              }
            });
        } catch (error) {
          if (li.isConnected)
            body.replaceChildren(node('p', 'st-v-error', error.message));
        }
      }
      disclosure.addEventListener('toggle', function () {
        if (disclosure.open && !disclosure.dataset.loaded) {
          disclosure.dataset.loaded = 'true';
          load();
        }
      });
      if (target && (item.selected || item.id === target)) disclosure.open = true;
    }
    function planBadge(host, item) {
      var status = item.status || item.planStatus || 'none';
      var span = node(
        'span',
        'st-v-badge is-plan-' + status,
        status === 'approved'
          ? 'Approved'
          : status === 'revised'
            ? 'Revision requested'
            : 'Proposed',
      );
      span.dataset.planStatus = status;
      host.appendChild(span);
      if (item.nonBlocking) badge(host, 'Non-blocking');
    }
    function renderActivityItem(item, host, frame, target) {
      var li = node('li', 'st-v-activity-item st-v-kind-' + item.kind);
      li.dataset.itemId = item.id;
      li.tabIndex = -1;
      var header = node('div', 'st-v-item-header');
      header.appendChild(
        node(
          'h5',
          '',
          (item.nativeOnly ? 'Native source record · ' : '') + (item.title || item.kind),
        ),
      );
      header.appendChild(timestamp(item.timestamp));
      if (item.isError) badge(header, 'Failed', 'is-error');
      if (item.kind === 'plan' && !item.nativeOnly) planBadge(header, item);
      li.appendChild(header);
      if (item.path) li.appendChild(node('p', 'st-v-path', item.path));
      if (item.kind === 'observation')
        li.appendChild(node('p', 'st-v-note', observationNote(item)));
      if (item.sha256) li.appendChild(node('p', 'st-v-hash', 'SHA-256: ' + item.sha256));
      if (item.toolCallId) sourceLink(item, li);
      var body = node('div', 'st-v-item-body');
      li.appendChild(body);
      var selected = resolveItem(target) === item.id,
        ref = item.textRef && manifest.textStore.refs[item.textRef];
      var bodySelected = selected && (!state.textRef || state.textRef === item.textRef);
      var shortProse =
        !item.nativeOnly &&
        ['ai', 'decision', 'plan', 'note'].includes(item.kind) &&
        ref &&
        ref.pages.length === 1 &&
        ref.bytes <= 32768;
      var initialOpen =
        bodySelected || (item.kind === 'ai' ? state.aiMode === 'full' : shortProse);
      var disclosure = node('details', 'st-v-item-disclosure');
      disclosure.open = initialOpen;
      disclosure.appendChild(
        node(
          'summary',
          '',
          item.kind === 'ai'
            ? 'AI response'
            : item.kind === 'revision'
              ? 'Read captured diff'
              : item.kind === 'tool'
                ? 'Read tool call and result'
                : 'Read recorded text',
        ),
      );
      if (item.preview && !initialOpen)
        body.appendChild(node('p', 'st-v-preview', item.preview));
      body.appendChild(disclosure);
      function load() {
        if (!disclosure.open || disclosure.dataset.loaded) return;
        disclosure.dataset.loaded = 'true';
        renderText(disclosure, item.textRef, item, {
          page: bodySelected ? state.textPage : 0,
          rich:
            !item.nativeOnly && ['ai', 'decision', 'plan', 'note'].includes(item.kind),
          primary: bodySelected,
        });
      }
      disclosure.addEventListener('toggle', load);
      load();
      if (item.resultRef) {
        var output = node('details', 'st-v-tool-output');
        output.appendChild(node('summary', '', 'Tool output'));
        output.addEventListener('toggle', function () {
          if (output.open && !output.dataset.loaded) {
            output.dataset.loaded = 'true';
            var outputSelected = selected && state.textRef === item.resultRef;
            renderText(output, item.resultRef, item, {
              page: outputSelected ? state.textPage : 0,
              primary: outputSelected,
            });
          }
        });
        li.appendChild(output);
        if (selected && state.textRef === item.resultRef) output.open = true;
      }
      if (item.feedback) {
        var feedback = node('section', 'st-v-plan-feedback');
        feedback.appendChild(node('h6', '', 'Revision feedback'));
        rich(feedback, item.feedback);
        li.appendChild(feedback);
      }
      if (item.rawRefs && item.rawRefs.length) {
        var raw = node('details', 'st-v-raw');
        raw.dataset.rawRecords = item.id;
        raw.appendChild(
          node('summary', '', 'Raw captured data (' + item.rawRefs.length + ')'),
        );
        raw.addEventListener('toggle', function () {
          if (!raw.open || raw.dataset.loaded) return;
          raw.dataset.loaded = 'true';
          var select = node('select');
          select.setAttribute('aria-label', 'Raw record');
          var rawHost = node('div');
          var recordPager = node('div');
          raw.append(recordPager, select, rawHost);
          var rawPage =
            selected && item.rawRefs.includes(state.textRef)
              ? Math.floor(item.rawRefs.indexOf(state.textRef) / ACTIVITY_SIZE)
              : 0;
          function records() {
            recordPager.replaceChildren();
            select.replaceChildren();
            if (item.rawRefs.length > ACTIVITY_SIZE)
              pager(
                recordPager,
                item.rawRefs.length,
                rawPage,
                ACTIVITY_SIZE,
                function (page) {
                  rawPage = page;
                  records();
                },
                'st-viewer-raw-' + item.id,
              );
            item.rawRefs
              .slice(rawPage * ACTIVITY_SIZE, (rawPage + 1) * ACTIVITY_SIZE)
              .forEach(function (ref, i) {
                var option = node(
                  'option',
                  '',
                  'Record ' + (rawPage * ACTIVITY_SIZE + i + 1),
                );
                option.value = ref;
                select.appendChild(option);
              });
            if (
              selected &&
              Array.from(select.options).some(function (option) {
                return option.value === state.textRef;
              })
            )
              select.value = state.textRef;
            change();
          }
          function change() {
            rawHost.replaceChildren();
            var rawSelected = selected && select.value === state.textRef;
            renderText(rawHost, select.value, item, {
              raw: true,
              page: rawSelected ? state.textPage : 0,
              primary: rawSelected,
            });
          }
          select.addEventListener('change', change);
          records();
        });
        li.appendChild(raw);
        if (selected && item.rawRefs.includes(state.textRef)) raw.open = true;
      }
      host.appendChild(li);
    }
    function observationNote(item) {
      if (item.basis === 'workspace-delta')
        return 'Observed workspace diff · author unverified. This may include another process’s or later manual changes.';
      if (item.basis === 'shell-write-attempt')
        return (
          'File state after ' +
          (item.toolOutcome === 'failed' || item.isError
            ? 'a failed'
            : item.toolOutcome === 'succeeded'
              ? 'a successful'
              : 'a') +
          ' shell attempt. This is not an attributed applied edit.'
        );
      return 'File state observed after tool activity. This does not establish who changed the file.';
    }
    function sourceLink(item, host) {
      if (!item.toolCallId) return;
      host.appendChild(
        button('Open source tool call', 'st-v-source-link', async function () {
          try {
            await ready;
            var id = resolveItem(item.toolCallId),
              owner = turnById.get(item.turnId);
            if (!owner) {
              var located = await channel.call('locate', { itemId: id });
              owner = turnById.get(located.turnId);
              id = located.itemId;
            }
            if (!owner)
              throw new Error(
                'The source tool is not available in this report selection.',
              );
            openSelection(owner.id, id, true, 0);
          } catch (error) {
            setStatus(error.message, true);
          }
        }),
      );
    }
    function renderIndexItem(item, list, epoch) {
      var li = node('li', 'st-v-index-item');
      li.dataset.itemId = item.id;
      if (state.scope === 'plans') li.dataset.planId = item.id;
      var disclosure = node('details', 'st-v-index-disclosure');
      disclosure.dataset.indexId = item.id;
      var summary = node(
        'summary',
        '',
        item.title ||
          item.path ||
          (state.scope === 'plans' ? 'Plan' : 'File observation'),
      );
      if (state.scope === 'plans') {
        summary.appendChild(document.createTextNode(' '));
        planBadge(summary, item);
      }
      disclosure.appendChild(summary);
      var meta = node('p', 'st-v-meta');
      meta.appendChild(timestamp(item.timestamp));
      if (item.author) meta.appendChild(document.createTextNode(' · ' + item.author));
      disclosure.appendChild(meta);
      if (state.scope === 'plans') {
        if (item.capturedRecords > 1)
          disclosure.appendChild(
            node('p', 'st-v-note', item.capturedRecords + ' captured records'),
          );
      } else disclosure.appendChild(node('p', 'st-v-note', observationNote(item)));
      if (item.sha256)
        disclosure.appendChild(node('p', 'st-v-hash', 'SHA-256: ' + item.sha256));
      if (item.feedback) {
        var feedback = node('section', 'st-v-plan-feedback');
        feedback.appendChild(node('h4', '', 'Revision feedback'));
        rich(feedback, item.feedback);
        disclosure.appendChild(feedback);
      }
      if (item.turnId && turnById.has(item.turnId))
        disclosure.appendChild(
          button('Read source exchange', 'st-v-plan-source', function () {
            openSelection(item.turnId, item.itemId || item.id, true, 0);
          }),
        );
      else if (state.scope === 'plans')
        disclosure.appendChild(
          node('p', 'st-v-orphan-plan', 'No linked source exchange in this report.'),
        );
      if (item.toolCallId) sourceLink(item, disclosure);
      disclosure.addEventListener('toggle', function () {
        if (disclosure.open && !disclosure.dataset.loaded) {
          disclosure.dataset.loaded = 'true';
          var hit = state.search && state.search.hits && state.search.hits[item.id];
          renderText(disclosure, item.textRef, item, {
            page: (hit && hit.page) || 0,
            rich: state.scope === 'plans',
            primary: true,
          });
        }
      });
      li.appendChild(disclosure);
      list.appendChild(li);
      if (state.selected === item.id) disclosure.open = true;
    }
    function renderSession(session, list) {
      var li = node('li', 'st-v-session');
      li.dataset.sessionId = session.id;
      var disclosure = node('details');
      disclosure.appendChild(node('summary', '', session.label || session.id));
      var range = node('p', 'st-v-meta');
      range.append(
        timestamp(session.from),
        document.createTextNode(' – '),
        timestamp(session.to),
      );
      disclosure.appendChild(range);
      disclosure.appendChild(
        node(
          'p',
          'st-v-note',
          [
            session.tool,
            (session.authors || []).join(', '),
            (session.models || []).join(', '),
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      );
      var stats = node('dl', 'st-v-stats');
      metric(
        stats,
        'Exchanges',
        session.promptCount === undefined
          ? (session.turnIds || []).length
          : session.promptCount,
      );
      metric(stats, 'Captured revisions', session.revisionCount);
      metric(stats, 'Files', session.fileCount);
      metric(stats, 'Plans', session.planCount);
      metric(stats, 'Decisions', session.decisionCount);
      metric(stats, 'Failed tools', session.failedTools);
      disclosure.appendChild(stats);
      usage(disclosure, session.stats, 'st-v-session-stats');
      disclosure.appendChild(
        button('Read conversation', 'st-v-session-source', function () {
          state.scope = 'prompts';
          state.session = session.id;
          state.page = 0;
          state.open = [];
          state.selected = state.item = null;
          syncControls();
          render();
          writeHash();
        }),
      );
      if ((session.unlinkedIds || []).length)
        disclosure.appendChild(
          button('Read unlinked work', '', function () {
            state.scope = 'unlinked';
            state.session = session.id;
            state.page = 0;
            syncControls();
            render();
            writeHash();
          }),
        );
      li.appendChild(disclosure);
      list.appendChild(li);
    }
    async function renderText(host, ref, item, options) {
      options = options || {};
      var localEpoch = ++textRequest;
      var panel = node('section', 'st-v-text-panel');
      panel.dataset.textRef = ref || '';
      panel.dataset.textRequest = String(localEpoch);
      var content = node(
        'div',
        'st-v-text',
        ref
          ? 'Loading recorded content…'
          : 'No exact text or diff was persisted for this record.',
      );
      if (options.primary) {
        ['st-viewer-text', 'st-viewer-text-previous', 'st-viewer-text-next'].forEach(
          function (id) {
            var previous = document.getElementById(id);
            if (previous) previous.removeAttribute('id');
          },
        );
        content.id = 'st-viewer-text';
      }
      panel.appendChild(content);
      host.appendChild(panel);
      if (!ref) return;
      try {
        await ready;
        var result = await channel.call(
          options.rich && !options.raw ? 'getRichPage' : 'getPage',
          { ref: ref, page: options.page || 0 },
        );
        if (disposed || !panel.isConnected) return;
        var pagination = node('div', 'st-v-pager st-v-text-pager');
        var previous = button('Previous text page', '', function () {
            options.page = result.page - 1;
            replace();
          }),
          next = button('Next text page', '', function () {
            options.page = result.page + 1;
            replace();
          });
        previous.dataset.textPrevious = ref;
        next.dataset.textNext = ref;
        previous.disabled = result.page === 0;
        next.disabled = result.page + 1 >= result.pages;
        if (options.primary) {
          previous.id = 'st-viewer-text-previous';
          next.id = 'st-viewer-text-next';
        }
        pagination.append(
          previous,
          node(
            'span',
            '',
            'Text page ' +
              (result.page + 1) +
              ' of ' +
              result.pages +
              ' · ' +
              result.lines +
              ' lines · ' +
              size(result.bytes),
          ),
          next,
        );
        if (result.pages > 1) panel.insertBefore(pagination, content);
        else {
          var sizeLabel = node(
            'p',
            'st-v-text-size',
            result.lines + ' lines · ' + size(result.bytes),
          );
          panel.insertBefore(sizeLabel, content);
        }
        function replace() {
          if (options.turnId || (item && item.turnId) || options.primary) {
            state.selected = options.turnId || (item && item.turnId) || state.selected;
            state.item = (item && item.id) || null;
            state.textRef = ref;
            state.textPage = options.page;
            writeHash();
          }
          panel.remove();
          renderText(host, ref, item, options);
        }
        content.replaceChildren();
        var isDiff =
          !options.raw &&
          item &&
          (item.kind === 'revision' || item.basis === 'workspace-delta');
        if (options.rich && !isDiff) rich(content, result.text, result.context);
        else {
          var pre = node(
            'pre',
            isDiff
              ? 'st-v-diff'
              : options.raw || (item && item.kind === 'tool')
                ? ''
                : 'st-v-prose',
          );
          if (isDiff) {
            var lines = result.text.split('\n');
            var codeHelper = global.ShowtailRichText && global.ShowtailRichText.code;
            var codeBudget = Math.max(
              0,
              Math.min(1000, 6500 - app.querySelectorAll('*').length - lines.length),
            );
            lines.forEach(function (line) {
              var row = node('span', 'st-v-diff-line', line || '\u200b');
              if (line.length <= 4096) {
                if (line.startsWith('+')) row.classList.add('is-add');
                else if (line.startsWith('-')) row.classList.add('is-del');
                else if (line.startsWith('@@')) row.classList.add('is-hunk');
                if (
                  typeof codeHelper === 'function' &&
                  codeBudget > 2 &&
                  /^[ +\-]/.test(line) &&
                  !/^(\+\+\+|---)/.test(line)
                ) {
                  try {
                    var colored = codeHelper(line.slice(1), { maxNodes: codeBudget - 1 });
                    if (
                      colored &&
                      colored.nodeType &&
                      Number.isFinite(colored.nodeCount)
                    ) {
                      codeBudget -= colored.nodeCount + 1;
                      row.replaceChildren(
                        document.createTextNode(line.charAt(0)),
                        colored,
                      );
                    }
                  } catch (error) {}
                }
              }
              pre.appendChild(row);
            });
          } else pre.textContent = result.text;
          content.appendChild(pre);
        }
        content.dataset.loaded = 'true';
        panel.dataset.textPage = String(result.page);
        content.dataset.textRef = ref;
        content.dataset.textPage = String(result.page);
        var download = button(
          'Download full ' +
            (isDiff ? 'diff' : options.raw ? 'raw record' : 'text') +
            ' (' +
            size(result.bytes) +
            ')',
          'st-v-download',
          async function () {
            download.disabled = true;
            try {
              var full = await channel.call('download', { ref: ref }),
                url = URL.createObjectURL(
                  new Blob(full.parts, { type: 'text/plain;charset=utf-8' }),
                ),
                anchor = node('a');
              anchor.href = url;
              anchor.download =
                ((item && item.path
                  ? item.path.split(/[\\/]/).pop()
                  : item
                    ? item.kind
                    : 'prompt') || 'record') + (isDiff ? '.diff' : '.txt');
              document.body.appendChild(anchor);
              anchor.click();
              anchor.remove();
              setTimeout(function () {
                URL.revokeObjectURL(url);
              }, 10000);
            } catch (error) {
              setStatus('Download could not complete: ' + error.message, true);
            } finally {
              download.disabled = false;
            }
          },
        );
        download.dataset.downloadRef = ref;
        panel.appendChild(download);
      } catch (error) {
        if (panel.isConnected) {
          content.textContent = 'Recorded content could not be opened: ' + error.message;
          content.classList.add('st-v-error');
        }
      }
    }
    function changedFilter() {
      state.page = 0;
      state.open = [];
      state.selected = state.item = null;
      render();
      writeHash();
    }
    function syncControls() {
      searchInput.value = state.query;
      sessionSelect.value = state.session;
      toolSelect.value = state.tool;
      if (authorSelect) authorSelect.value = state.author;
      sortSelect.value = state.sort;
      groupSelect.value = state.group;
      fileInput.value = state.file;
      fromInput.value = state.from;
      untilInput.value = state.until;
      aiInput.checked = state.showAi;
    }
    function openSelection(id, itemId, focus, textPage) {
      var turn = turnById.get(id);
      if (!turn) {
        state.scope = observationById.has(id) ? 'observations' : 'plans';
        state.selected = id;
        state.page = 0;
        render();
        writeHash();
        return;
      }
      state.scope = turn.unlinked ? 'unlinked' : 'prompts';
      state.session =
        state.tool =
        state.author =
        state.file =
        state.from =
        state.until =
          '';
      state.selected = turn.id;
      state.item = resolveItem(itemId) || null;
      state.textRef = null;
      state.textPage = Number(textPage) || 0;
      var rows = filteredRows(),
        index = rows.findIndex(function (row) {
          return row.id === turn.id;
        });
      if (index < 0) {
        state.query = '';
        state.search = null;
        rows = filteredRows();
        index = rows.findIndex(function (row) {
          return row.id === turn.id;
        });
      }
      state.page = Math.max(0, Math.floor(index / READER_SIZE));
      state.open = state.open.filter(function (id) {
        return rows
          .slice(state.page * READER_SIZE, (state.page + 1) * READER_SIZE)
          .some(function (row) {
            return row.id === id;
          });
      });
      if (!state.open.includes(turn.id)) state.open.push(turn.id);
      syncControls();
      render();
      writeHash();
      if (focus) {
        var frame = frames.get(turn.id);
        if (frame) {
          frame.host.focus({ preventScroll: true });
          if (!itemId) frame.host.scrollIntoView({ block: 'start' });
        }
      }
    }
    function writeHash(replace) {
      var params = new URLSearchParams();
      params.set('section', state.scope);
      if (state.page) params.set('page', String(state.page));
      ['query', 'session', 'tool', 'author', 'file', 'from', 'until'].forEach(
        function (key) {
          if (state[key]) params.set(key, state[key]);
        },
      );
      params.set('sort', state.sort);
      params.set('group', state.group);
      state.open.slice(0, 10).forEach(function (id) {
        params.append('open', id);
      });
      if (state.selected) params.set('turn', state.selected);
      if (state.item) params.set('item', state.item);
      if (state.textPage) params.set('textPage', String(state.textPage));
      if (state.textRef) params.set('textRef', state.textRef);
      var currentFrame = state.selected && viewPrefs.get(state.selected);
      if (currentFrame) {
        if (currentFrame.page) params.set('activityPage', String(currentFrame.page));
        if (currentFrame.kind !== 'all') params.set('activityKind', currentFrame.kind);
        if (currentFrame.tab === 'files') params.set('tab', 'files');
        if (currentFrame.file) params.set('filePath', currentFrame.file);
      }
      var next = '#' + params.toString();
      if (next === location.hash) return;
      if (replace) {
        history.replaceState(null, '', next);
        return;
      }
      ownHashWrites.set(next, (ownHashWrites.get(next) || 0) + 1);
      location.hash = next;
    }
    function onHashChange(event) {
      var value = new URL(event.newURL).hash,
        count = ownHashWrites.get(value) || 0;
      if (count) {
        if (count === 1) ownHashWrites.delete(value);
        else ownHashWrites.set(value, count - 1);
        return;
      }
      readHash();
    }
    function readHash() {
      if (location.hash.startsWith('#st-tool-')) {
        var legacyId;
        try {
          legacyId = decodeURIComponent(location.hash.slice(9));
        } catch (error) {
          setStatus('This source link contains an invalid record identity.', true);
          return;
        }
        channel.call('locate', { itemId: resolveItem(legacyId) }).then(
          function (located) {
            if (disposed) return;
            if (!located.turnId) {
              setStatus(
                'The source record is not available in this report selection.',
                true,
              );
              return;
            }
            openSelection(located.turnId, located.itemId, true, 0);
          },
          function (error) {
            setStatus(error.message, true);
          },
        );
        return;
      }
      var params = new URLSearchParams(location.hash.slice(1));
      var section =
        params.get('section') ||
        params.get('view') ||
        params.get('scope') ||
        (params.has('turn') || params.has('query') ? 'prompts' : 'overview');
      if (section === 'exchanges') section = 'prompts';
      state.scope = sections.some(function (entry) {
        return entry[0] === section;
      })
        ? section
        : 'prompts';
      ['query', 'session', 'tool', 'author', 'file', 'from', 'until'].forEach(
        function (key) {
          state[key] = params.get(key) || '';
        },
      );
      state.sort = params.has('sort')
        ? params.get('sort') === 'newest'
          ? 'newest'
          : 'oldest'
        : preferences.sort === 'newest'
          ? 'newest'
          : 'oldest';
      state.page = Math.max(0, Number(params.get('page')) || 0);
      state.selected = params.get('turn');
      state.item = resolveItem(params.get('item'));
      state.textPage = Math.max(0, Number(params.get('textPage')) || 0);
      state.textRef = own(manifest.textStore.refs, params.get('textRef'))
        ? params.get('textRef')
        : null;
      state.open = params
        .getAll('open')
        .filter(function (id) {
          return turnById.has(id);
        })
        .slice(0, 10);
      if (
        state.selected &&
        turnById.has(state.selected) &&
        !state.open.includes(state.selected)
      )
        state.open.push(state.selected);
      state.group = params.has('group')
        ? params.get('group') === 'session'
          ? 'session'
          : 'time'
        : preferences.group === 'session'
          ? 'session'
          : 'time';
      if (state.selected && turnById.has(state.selected)) {
        var selectedTurn = turnById.get(state.selected);
        state.scope = selectedTurn.unlinked ? 'unlinked' : 'prompts';
        var rows = filteredRows(),
          selectedIndex = rows.findIndex(function (row) {
            return row.id === state.selected;
          });
        if (selectedIndex >= 0) state.page = Math.floor(selectedIndex / READER_SIZE);
        viewPrefs.set(state.selected, {
          page: Math.max(0, Number(params.get('activityPage')) || 0),
          kind: params.get('activityKind') || 'all',
          tab: params.get('tab') === 'files' ? 'files' : 'activity',
          file: params.get('filePath') || '',
        });
      }
      syncControls();
      if (state.query) runSearch(true);
      else {
        state.search = null;
        render();
      }
    }
    function runSearch(immediate) {
      clearTimeout(searchTimer);
      var epoch = ++queryEpoch;
      state.query = searchInput.value.trim();
      state.search = null;
      state.searching = !!state.query;
      if (!immediate) {
        state.page = 0;
        state.open = [];
        state.selected = state.item = state.textRef = null;
        state.textPage = 0;
      }
      if (!state.query) {
        if (channel) channel.call('cancelSearch', {}).catch(function () {});
        render();
        writeHash();
        return;
      }
      render();
      searchTimer = setTimeout(
        async function () {
          try {
            await ready;
            var result = await channel.call(
              'search',
              { query: state.query },
              function (progress) {
                if (epoch !== queryEpoch) return;
                state.search = progress;
                render();
              },
            );
            if (epoch !== queryEpoch) return;
            state.search = result;
            state.searching = false;
            render();
            if (!immediate) writeHash();
          } catch (error) {
            if (epoch === queryEpoch) {
              state.searching = false;
              setStatus('Search could not complete: ' + error.message, true);
            }
          }
        },
        immediate ? 0 : 150,
      );
    }
    searchInput.addEventListener('input', function () {
      runSearch(false);
    });
    global.addEventListener('hashchange', onHashChange);
    function dispose() {
      disposed = true;
      clearTimeout(searchTimer);
      if (channel) channel.close();
      global.removeEventListener('hashchange', onHashChange);
    }
    global.addEventListener('pagehide', dispose, { once: true });
    render();
    ready = (async function () {
      try {
        channel = createChannel(false);
        await channel.call('init', { manifest: manifest });
      } catch (error) {
        if (channel) channel.close();
        channel = createChannel(true);
        await channel.call('init', { manifest: manifest });
      }
      app.dataset.ready = 'true';
      app.dataset.runtime = channel.mode;
      readHash();
      return true;
    })().catch(function (error) {
      setStatus(error.message, true);
      throw error;
    });
    var instance = {
      ready: ready,
      state: state,
      manifest: manifest,
      dispose: dispose,
      stats: function () {
        return channel.call('stats', {});
      },
    };
    global.ShowtailViewer.active = instance;
    return instance;
  }
  global.ShowtailViewer = { start: start };
})(window);
