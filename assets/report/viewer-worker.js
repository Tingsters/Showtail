(function (global) {
  'use strict';
  // The same trusted engine runs in a Blob worker or a yielding main-thread
  // bridge. Captured content is data throughout; it is never evaluated.
  function create(send) {
    var index,
      store,
      searchToken = 0,
      totalCached = 0,
      peakCached = 0;
    var cache = new Map(),
      loading = new Map(),
      waiting = new Map();
    var MAX_CHUNK = 256 * 1024,
      MAX_CACHE = 16 * 1024 * 1024;
    var encoder = new TextEncoder();
    function own(object, key) {
      return Object.prototype.hasOwnProperty.call(object || {}, key);
    }
    function fail(message) {
      throw new Error(message);
    }
    function pause() {
      return new Promise(function (resolve) {
        setTimeout(resolve, 0);
      });
    }
    function refFor(id) {
      if (!store || !own(store.refs, id)) fail('This text reference is unavailable.');
      return store.refs[id];
    }
    function cached(key) {
      if (!cache.has(key)) return;
      var hit = cache.get(key);
      cache.delete(key);
      cache.set(key, hit);
      return hit.value;
    }
    function remember(key, value, size) {
      if (size > MAX_CACHE) return value;
      if (cache.has(key)) {
        totalCached -= cache.get(key).size;
        cache.delete(key);
      }
      while (totalCached + size > MAX_CACHE && cache.size) {
        var oldest = cache.keys().next().value;
        totalCached -= cache.get(oldest).size;
        cache.delete(oldest);
      }
      cache.set(key, { value: value, size: size });
      totalCached += size;
      peakCached = Math.max(peakCached, totalCached);
      return value;
    }
    function needChunk(id) {
      if (!waiting.has(id)) {
        var resolve, reject;
        var promise = new Promise(function (yes, no) {
          resolve = yes;
          reject = no;
        });
        var timer = setTimeout(function () {
          waiting.delete(id);
          reject(new Error('The embedded content chunk did not arrive.'));
        }, 15000);
        waiting.set(id, {
          promise: promise,
          resolve: resolve,
          reject: reject,
          timer: timer,
        });
        send({ type: 'needChunk', chunk: id });
        return promise;
      }
      return waiting.get(id).promise;
    }
    async function loadChunk(id) {
      var hit = cached(id);
      if (hit) return hit;
      if (loading.has(id)) return loading.get(id);
      var promise = (async function () {
        if (!own(store.chunks, id)) fail('Unknown embedded content chunk.');
        var meta = store.chunks[id];
        if (
          !Number.isSafeInteger(meta.decodedBytes) ||
          meta.decodedBytes < 2 ||
          meta.decodedBytes > MAX_CHUNK ||
          !Number.isSafeInteger(meta.encodedBytes) ||
          meta.encodedBytes < 1 ||
          meta.encodedBytes > Math.ceil((MAX_CHUNK + 1024) / 3) * 4
        )
          fail('Embedded content exceeds the supported chunk limit.');
        if (typeof DecompressionStream !== 'function')
          fail('This browser cannot decompress this report. Use a current browser.');
        var encoded = await needChunk(id);
        if (
          typeof encoded !== 'string' ||
          encoded.length !== meta.encodedBytes ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
        )
          fail('The embedded content chunk is damaged.');
        var raw = atob(encoded);
        var bytes = Uint8Array.from(raw, function (character) {
          return character.charCodeAt(0);
        });
        var reader = new ReadableStream({
          start: function (controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        })
          .pipeThrough(new DecompressionStream('gzip'))
          .getReader();
        var decoder = new TextDecoder('utf-8', { fatal: true }),
          text = '',
          size = 0,
          completed = false;
        try {
          while (true) {
            var next = await reader.read();
            if (next.done) {
              completed = true;
              break;
            }
            size += next.value.byteLength;
            if (size > meta.decodedBytes || size > MAX_CHUNK)
              fail('The expanded content exceeds its declared limit.');
            text += decoder.decode(next.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          if (!completed) await reader.cancel().catch(function () {});
          reader.releaseLock();
        }
        if (size !== meta.decodedBytes)
          fail('The embedded content size does not match its manifest.');
        var value = JSON.parse(text);
        if (!value || Array.isArray(value) || typeof value !== 'object')
          fail('Invalid content page map.');
        for (var pageId of Object.keys(value)) {
          var page = store.pages[pageId];
          if (
            !own(store.pages, pageId) ||
            page.chunk !== id ||
            typeof value[pageId] !== 'string' ||
            encoder.encode(value[pageId]).byteLength !== page.bytes ||
            page.bytes > 32 * 1024 ||
            !Number.isSafeInteger(page.lines) ||
            page.lines < 1 ||
            page.lines > 200 ||
            value[pageId].split('\n').length !== page.lines
          )
            fail('Invalid or oversized content page.');
        }
        return remember(id, value, size);
      })();
      loading.set(id, promise);
      try {
        return await promise;
      } finally {
        loading.delete(id);
      }
    }
    async function pageText(id) {
      if (!own(store.pages, id)) fail('This content page is unavailable.');
      var data = await loadChunk(store.pages[id].chunk);
      if (!own(data, id)) fail('The embedded content page is missing.');
      return data[id];
    }
    async function getPage(id, number) {
      var ref = refFor(id);
      if (!Array.isArray(ref.pages) || !ref.pages.length)
        fail('This text has no content pages.');
      number = Math.max(
        0,
        Math.min(ref.pages.length - 1, Math.floor(Number(number) || 0)),
      );
      var pageId = ref.pages[number],
        text = await pageText(pageId);
      return {
        text: text,
        page: number,
        pages: ref.pages.length,
        bytes: ref.bytes,
        lines: ref.lines,
        pageBytes: store.pages[pageId].bytes,
        pageLines: store.pages[pageId].lines,
      };
    }
    function markdownState() {
      return {
        fence: null,
        table: null,
        list: null,
        quoteDepth: 0,
        previous: '',
        previousOversized: false,
        tail: '',
        longLine: false,
      };
    }
    function tableRow(line) {
      return /^\s*\|.*\|\s*$/.test(line);
    }
    function tableSeparator(line) {
      return (
        tableRow(line) &&
        line
          .trim()
          .slice(1, -1)
          .split('|')
          .every(function (cell) {
            return /^\s*:?-+:?\s*$/.test(cell);
          })
      );
    }
    function advanceMarkdown(state, text) {
      var lines = (state.tail + text).split('\n');
      state.tail = lines.pop();
      var continuedLongLine = state.longLine;
      state.longLine = continuedLongLine && !lines.length;
      for (var line of lines) {
        if (continuedLongLine) {
          continuedLongLine = false;
          state.previous = '';
          state.previousOversized = false;
          continue;
        }
        if (state.fence) {
          var clean = line;
          for (var q = 0; q < (state.fence.quoteDepth || 0); q++)
            clean = clean.replace(/^\s*> ?/, '');
          var closing = /^\s*(`{3,}|~{3,})\s*$/.exec(clean);
          if (
            closing &&
            closing[1][0] === state.fence.marker[0] &&
            closing[1].length >= (state.fence.length || state.fence.marker.length)
          )
            state.fence = null;
          continue;
        }
        var quote = /^(?:\s*> ?)+/.exec(line);
        state.quoteDepth = quote ? Math.min(16, (quote[0].match(/>/g) || []).length) : 0;
        var clean = quote ? line.slice(quote[0].length) : line;
        var fence = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(clean);
        if (fence) {
          state.fence = {
            marker: fence[1].slice(0, 64),
            length: fence[1].length,
            oversized: fence[1].length > 64,
            language: fence[2].slice(0, 64),
            quoteDepth: state.quoteDepth,
          };
          state.table = null;
          state.previous = '';
          state.previousOversized = false;
          continue;
        }
        if (
          tableSeparator(clean) &&
          (tableRow(state.previous) || state.previousOversized)
        )
          state.table =
            state.previousOversized || clean.length > 2048
              ? { oversized: true }
              : { header: state.previous, separator: clean };
        else if (!tableRow(clean)) state.table = null;
        var list = /^(\s*)([-+*]|\d+[.)])\s+/.exec(clean);
        if (list)
          state.list = {
            ordered: /^\d/.test(list[2]),
            indent: Math.min(64, list[1].length),
            start: /^\d/.test(list[2]) ? Number.parseInt(list[2], 10) : undefined,
          };
        else if (!clean.trim() || !/^\s/.test(clean)) state.list = null;
        state.previous = clean.slice(0, 2048);
        state.previousOversized = tableRow(clean) && clean.length > 2048;
      }
      if (state.tail.length > 4096) {
        state.tail = '';
        state.longLine = true;
      }
      return state;
    }
    async function getRichPage(id, number) {
      var result = await getPage(id, number),
        key = 'rich:' + id,
        checkpoint = cached(key),
        state = markdownState(),
        start = 0;
      if (checkpoint && checkpoint.page <= result.page) {
        state = JSON.parse(JSON.stringify(checkpoint.state));
        start = checkpoint.page;
      }
      var ref = refFor(id),
        lastYield = performance.now();
      for (var at = start; at < result.page; at++) {
        advanceMarkdown(state, await pageText(ref.pages[at]));
        if (performance.now() - lastYield > 8) {
          await pause();
          lastYield = performance.now();
        }
      }
      result.context = {
        fence: state.fence,
        table: state.table,
        list: state.list,
        quoteDepth: state.quoteDepth,
        partialLine: !!state.tail || state.longLine,
      };
      advanceMarkdown(state, result.text);
      var next = { page: result.page + 1, state: state };
      remember(key, next, encoder.encode(JSON.stringify(next)).byteLength);
      return result;
    }
    async function fullText(id, current) {
      var ref = refFor(id),
        parts = [],
        bytes = 0,
        lastYield = performance.now();
      if (
        !Number.isSafeInteger(ref.bytes) ||
        ref.bytes < 0 ||
        ref.bytes > 512 * 1024 * 1024
      )
        fail('Unsupported text size.');
      for (var page of ref.pages) {
        if (current && !current()) fail('Selection changed.');
        var text = await pageText(page);
        bytes += encoder.encode(text).byteLength;
        if (bytes > ref.bytes) fail('Text exceeds its declared size.');
        parts.push(text);
        if (performance.now() - lastYield > 8) {
          await pause();
          lastYield = performance.now();
        }
      }
      if (bytes !== ref.bytes) fail('Text size does not match its manifest.');
      return parts;
    }
    async function turnItems(turn, current) {
      if (turn.itemsRef) {
        var key = 'metadata:' + turn.id,
          hit = cached(key);
        if (hit) return hit;
        var items = JSON.parse((await fullText(turn.itemsRef, current)).join(''));
        if (
          !Array.isArray(items) ||
          items.some(function (item) {
            return !item || typeof item.id !== 'string' || typeof item.kind !== 'string';
          })
        )
          fail('Invalid turn metadata.');
        return remember(key, items, refFor(turn.itemsRef).bytes);
      }
      return (turn.itemIds || [])
        .map(function (id) {
          return own(index.items, id) ? index.items[id] : null;
        })
        .filter(Boolean);
    }
    function allTurns() {
      return (index.turns || []).concat(index.unlinked || []);
    }
    async function getTurn(id) {
      var turn = allTurns().find(function (entry) {
        return entry.id === id;
      });
      if (!turn) fail('The selected turn is unavailable.');
      var items = await turnItems(turn);
      return { turnId: id, items: items };
    }
    function toolGroup(turn, items, start, end) {
      var names = Object.create(null),
        failed = 0,
        others = 0;
      for (var i = start; i < end; i++) {
        var name = items[i].title || 'Tool';
        if (own(names, name) || Object.keys(names).length < 16)
          names[name] = (names[name] || 0) + 1;
        else others++;
        if (items[i].isError) failed++;
      }
      return {
        id: 'tool-group:' + turn.id + ':' + start,
        kind: 'tool_group',
        title: end - start + ' tool calls',
        preview: end - start + ' consecutive tool calls',
        timestamp: items[start].timestamp,
        count: end - start,
        failed: failed,
        toolNames: names,
        otherToolCalls: others,
        start: start,
        end: end,
      };
    }
    async function getTurnPage(request) {
      var found = await getTurn(request.turnId),
        items = found.items,
        counts = {
          total: items.length,
          byKind: Object.create(null),
          files: 0,
          failed: 0,
          native: 0,
        },
        files = new Map(),
        rows = [],
        selected,
        group;
      for (var item of items) {
        if (
          request.itemId &&
          (item.id === request.itemId ||
            item.recordId === request.itemId ||
            item.sourceId === request.itemId)
        )
          selected = item;
        if (item.nativeOnly) {
          counts.native++;
          continue;
        }
        counts.byKind[item.kind] = (counts.byKind[item.kind] || 0) + 1;
        if (item.isError) counts.failed++;
        if (item.kind === 'revision' && item.path)
          files.set(item.path, (files.get(item.path) || 0) + 1);
      }
      counts.total = Object.values(counts.byKind).reduce(function (sum, count) {
        return sum + count;
      }, 0);
      counts.files = files.size;
      var fileGroups = Array.from(files, function (entry) {
        return { path: entry[0], count: entry[1], revisions: entry[1] };
      });
      var selectedIndex = selected ? items.indexOf(selected) : -1;
      var nativeRequested =
        request.kind === 'native' || !!(selected && selected.nativeOnly);
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (nativeRequested) {
          if (item.nativeOnly) rows.push(item);
          continue;
        }
        if (item.nativeOnly) continue;
        if (item.kind === 'tool') {
          var end = i + 1;
          while (
            end < items.length &&
            items[end].kind === 'tool' &&
            !items[end].nativeOnly
          )
            end++;
          var candidate = toolGroup({ id: request.turnId }, items, i, end);
          if (selectedIndex >= i && selectedIndex < end) {
            candidate.selected = true;
            candidate.selectedItemId = selected.id;
            candidate.selectedPage = Math.floor((selectedIndex - i) / 20);
          }
          if (candidate.id === request.groupId) group = candidate;
          if (request.groupTools && end - i > 1) rows.push(candidate);
          else for (var at = i; at < end; at++) rows.push(items[at]);
          i = end - 1;
          continue;
        }
        rows.push(item);
      }
      if (request.groupId && !nativeRequested) {
        if (!group) fail('This tool group is unavailable.');
        rows = items.slice(group.start, group.end);
      }
      var kind = nativeRequested ? 'native' : request.kind || 'all',
        file = nativeRequested ? undefined : request.filePath || request.file;
      rows = rows.filter(function (item) {
        if (kind === 'native') return !!item.nativeOnly;
        if (request.showAi === false && item.kind === 'ai') return false;
        if (item.nativeOnly) return false;
        if (file && (item.kind !== 'revision' || item.path !== file)) return false;
        return (
          kind === 'all' ||
          kind === 'files' ||
          item.kind === kind ||
          (kind === 'tool' && item.kind === 'tool_group')
        );
      });
      var pageRows = kind === 'files' && !file ? fileGroups : rows;
      var page = Math.max(0, Math.floor(Number(request.page) || 0));
      if (selected) {
        var position = rows.findIndex(function (item) {
          return (
            item.id === selected.id ||
            (item.kind === 'tool_group' &&
              selectedIndex >= item.start &&
              selectedIndex < item.end)
          );
        });
        if (position >= 0) page = Math.floor(position / 20);
      }
      var pages = Math.max(1, Math.ceil(pageRows.length / 20));
      page = Math.min(pages - 1, page);
      return {
        turnId: request.turnId,
        kind: kind,
        items: kind === 'files' && !file ? [] : rows.slice(page * 20, page * 20 + 20),
        page: page,
        pages: pages,
        total: pageRows.length,
        counts: counts,
        fileGroups: fileGroups.slice(
          kind === 'files' && !file ? page * 20 : 0,
          kind === 'files' && !file ? page * 20 + 20 : 20,
        ),
        files: fileGroups.slice(
          kind === 'files' && !file ? page * 20 : 0,
          kind === 'files' && !file ? page * 20 + 20 : 20,
        ),
        selected: selected,
        group: group,
      };
    }
    async function locate(id) {
      var seen = new Set();
      while (own(index.aliases, id) && !seen.has(id)) {
        seen.add(id);
        id = index.aliases[id];
      }
      for (var turn of allTurns()) {
        var items = await turnItems(turn);
        var found = items.find(function (item) {
          return item.id === id || item.recordId === id || item.sourceId === id;
        });
        if (found) return { turnId: turn.id, itemId: found.id };
        await pause();
      }
      return { turnId: null, itemId: null };
    }
    function records() {
      var result = [];
      function addTurn(turn, scope) {
        var refs = new Set(turn.promptRef ? [turn.promptRef] : []);
        if (turn.recapRef) refs.add(turn.recapRef);
        var metadata = [turn.preview, turn.tool, turn.author].concat(turn.models || []);
        for (var id of turn.itemIds || []) {
          var item = index.items[id];
          if (!item) continue;
          if (item.textRef) refs.add(item.textRef);
          if (item.resultRef) refs.add(item.resultRef);
          for (var rawRef of item.rawRefs || []) refs.add(rawRef);
        }
        result.push({
          id: turn.id,
          scope: scope,
          refs: Array.from(refs),
          metadata: metadata.join('\n'),
          turn: turn,
        });
      }
      for (var turn of index.turns || []) addTurn(turn, 'prompts');
      for (var work of index.unlinked || []) addTurn(work, 'unlinked');
      for (var observation of index.observations || [])
        result.push({
          id: observation.id,
          scope: 'observations',
          refs: observation.textRef ? [observation.textRef] : [],
          metadata: [observation.path, observation.preview, observation.basis].join('\n'),
        });
      for (var plan of index.plans || [])
        result.push({
          id: plan.id,
          scope: 'plans',
          refs: plan.textRef ? [plan.textRef] : [],
          metadata: [plan.title, plan.preview, plan.feedback, plan.status].join('\n'),
          itemId: plan.itemId,
        });
      return result;
    }
    async function search(request) {
      var requestEpoch = ++searchToken,
        query = String(request.query || '')
          .slice(0, 512)
          .toLowerCase();
      var matches = { prompts: [], unlinked: [], observations: [], plans: [] },
        snippets = Object.create(null),
        hits = Object.create(null);
      var list = records(),
        lastYield = performance.now(),
        lastProgress = lastYield;
      for (var i = 0; i < list.length; i++) {
        if (requestEpoch !== searchToken) fail('Search cancelled.');
        var record = list[i],
          found = !query || record.metadata.toLowerCase().includes(query),
          snippet = record.metadata,
          hit = {
            itemId: record.itemId,
            ref: record.turn ? record.turn.promptRef : record.refs[0],
            page: 0,
          },
          destinations = new Map();
        if (!found && record.turn) {
          var turnMetadata = await turnItems(record.turn),
            references = new Set(record.refs);
          for (var item of turnMetadata) {
            if (item.textRef) references.add(item.textRef);
            if (item.resultRef) {
              references.add(item.resultRef);
              destinations.set(item.resultRef, item.id);
            }
            for (var rawRef of item.rawRefs || []) {
              references.add(rawRef);
              if (!destinations.has(rawRef)) destinations.set(rawRef, item.id);
            }
            if (item.textRef && !destinations.has(item.textRef))
              destinations.set(item.textRef, item.id);
            var description = [
              item.title,
              item.preview,
              item.path,
              item.sourceId,
              item.recordId,
              item.id,
              item.isError ? 'failed' : '',
              JSON.stringify(item.nativeEvents || []),
            ].join('\n');
            if (!found && description.toLowerCase().includes(query)) {
              found = true;
              snippet = description;
              hit = { itemId: item.id, ref: item.textRef, page: 0 };
            }
          }
          record.refs = Array.from(references);
        }
        for (var textRef of found ? [] : record.refs) {
          var ref = refFor(textRef),
            carry = '';
          for (var pageNumber = 0; pageNumber < ref.pages.length; pageNumber++) {
            var pageId = ref.pages[pageNumber];
            if (requestEpoch !== searchToken) fail('Search cancelled.');
            var text = await pageText(pageId),
              joined = carry + text;
            var at = joined.toLowerCase().indexOf(query);
            if (at >= 0) {
              found = true;
              snippet = joined.slice(Math.max(0, at - 50), at + query.length + 100);
              hit = {
                itemId: destinations.get(textRef),
                ref: textRef,
                page: Math.max(0, pageNumber - (at < carry.length ? 1 : 0)),
              };
              break;
            }
            var overlap = Math.max(0, query.length - 1);
            carry = overlap ? joined.slice(-overlap) : '';
            if (performance.now() - lastYield > 8) {
              await pause();
              lastYield = performance.now();
            }
          }
          if (found) break;
        }
        if (found) {
          matches[record.scope].push(record.id);
          snippets[record.id] = snippet.replace(/\s+/g, ' ').slice(0, 240);
          hits[record.id] = hit;
        }
        if (performance.now() - lastProgress > 100) {
          send({
            id: request.id,
            ok: true,
            progress: true,
            result: {
              matches: matches,
              snippets: snippets,
              hits: hits,
              scanned: i + 1,
              total: list.length,
            },
          });
          lastProgress = performance.now();
        }
        if (performance.now() - lastYield > 8) {
          await pause();
          lastYield = performance.now();
        }
      }
      if (requestEpoch !== searchToken) fail('Search cancelled.');
      return {
        matches: matches,
        snippets: snippets,
        hits: hits,
        scanned: list.length,
        total: list.length,
      };
    }
    async function handle(request) {
      if (!request || typeof request !== 'object') return;
      if (request.type === 'chunk') {
        var entry = waiting.get(request.chunk);
        if (entry) {
          clearTimeout(entry.timer);
          waiting.delete(request.chunk);
          if (request.error) entry.reject(new Error(String(request.error)));
          else entry.resolve(request.data);
        }
        return;
      }
      try {
        var result;
        if (request.type === 'init') {
          index = request.manifest;
          store = index && index.textStore;
          if (
            !index ||
            index.viewerPayloadVersion !== 1 ||
            !store ||
            store.version !== 1 ||
            !store.refs ||
            !store.pages ||
            !store.chunks
          )
            fail('This report viewer version is not supported.');
          result = { ready: true };
        } else if (!store) fail('The report viewer has not initialized.');
        else if (request.type === 'getPage')
          result = await getPage(request.ref, request.page);
        else if (request.type === 'getRichPage')
          result = await getRichPage(request.ref, request.page);
        else if (request.type === 'getTurn') result = await getTurn(request.turnId);
        else if (request.type === 'getTurnPage') result = await getTurnPage(request);
        else if (request.type === 'locate') result = await locate(request.itemId);
        else if (request.type === 'search') result = await search(request);
        else if (request.type === 'cancelSearch') {
          searchToken++;
          result = { cancelled: true };
        } else if (request.type === 'download') {
          var ref = refFor(request.ref),
            parts = await fullText(request.ref);
          result = { parts: parts, bytes: ref.bytes };
        } else if (request.type === 'stats')
          result = {
            cachedBytes: totalCached,
            peakCachedBytes: peakCached,
            cachedChunks: Array.from(cache.keys()).filter(function (key) {
              return /^c\d+$/.test(key);
            }).length,
            cachedMetadata: Array.from(cache.keys()).filter(function (key) {
              return key.startsWith('metadata:');
            }).length,
          };
        else fail('Unsupported viewer operation.');
        send({ id: request.id, ok: true, result: result });
      } catch (error) {
        send({
          id: request.id,
          ok: false,
          error: error && error.message ? error.message : String(error),
        });
      }
    }
    return { handle: handle };
  }
  global.ShowtailReportWorker = { create: create };
  if (typeof document === 'undefined' && typeof global.postMessage === 'function') {
    var engine = create(function (message) {
      global.postMessage(message);
    });
    global.onmessage = function (event) {
      engine.handle(event.data);
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
