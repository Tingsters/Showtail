(function (global) {
  'use strict';
  // The same small language-agnostic vocabulary as the original report lexer.
  var keywordSet = new Set(
    'abstract and as assert async await bool boolean break byte case catch char class const continue def default del delete do double elif else enum except export extends false final finally float fn for from func function global goto if implements import in instanceof int interface is lambda let long match namespace new nil none None not null or override package pass private protected public raise readonly return self short sizeof static str string struct super switch template this throw throws trait true try type typedef typeof union unsigned using val var void volatile while with yield'.split(
      ' ',
    ),
  );
  var lexicalPattern =
    /(\/\/[^\n]*|#[^\n]*)|(\/\*[^]*?\*\/)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\w.]*\b)|([A-Za-z_$][\w$]*)/g;
  var byteCounter = new TextEncoder();
  /** Color only the mounted, bounded source. Long lines and budget overflow stay exact plain text. */
  function code(value, options) {
    options = options || {};
    var source = String(value === undefined ? '' : value),
      doc = options.document || global.document;
    if (!doc) throw new Error('A document is required to render code.');
    var result = doc.createDocumentFragment(),
      limit = Math.max(1, Math.min(2000, Number(options.maxNodes) || 256)),
      used = 0;
    function plain(text) {
      if (text) {
        result.appendChild(doc.createTextNode(text));
        used++;
      }
    }
    if (source.length > 64 * 1024) {
      plain(source);
      result.nodeCount = used;
      return result;
    }
    var pieces = [];
    function add(text, cls) {
      if (!text) return;
      var previous = pieces[pieces.length - 1];
      if (previous && previous.cls === cls) previous.text += text;
      else pieces.push({ text: text, cls: cls });
    }
    var lines = source.split('\n');
    for (var row = 0; row < lines.length; row++) {
      var line = lines[row],
        last = 0,
        match;
      if (line.length > 4096 || byteCounter.encode(line).byteLength > 4096) add(line);
      else {
        lexicalPattern.lastIndex = 0;
        while ((match = lexicalPattern.exec(line))) {
          add(line.slice(last, match.index));
          var cls = undefined;
          if (match[1] || match[2]) cls = 'tok-com';
          else if (match[3]) cls = 'tok-str';
          else if (match[4]) cls = 'tok-num';
          else if (keywordSet.has(match[0])) cls = 'tok-kw';
          else if (line[lexicalPattern.lastIndex] === '(') cls = 'tok-fn';
          add(match[0], cls);
          last = lexicalPattern.lastIndex;
        }
        add(line.slice(last));
      }
      if (row + 1 < lines.length) add('\n');
    }
    for (var n = 0; n < pieces.length; n++) {
      var piece = pieces[n],
        cost = piece.cls ? 2 : 1;
      if (cost > limit - used - (n + 1 < pieces.length ? 1 : 0)) {
        plain(
          pieces
            .slice(n)
            .map(function (rest) {
              return rest.text;
            })
            .join(''),
        );
        break;
      }
      if (piece.cls) {
        var span = doc.createElement('span');
        span.className = piece.cls;
        span.appendChild(doc.createTextNode(piece.text));
        result.appendChild(span);
        used += 2;
      } else plain(piece.text);
    }
    result.nodeCount = used;
    return result;
  }
  // Only DOM constructors and text nodes are used. Captured HTML remains text.
  function render(value, options) {
    options = options || {};
    var text = String(value === undefined ? '' : value),
      doc = options.document || global.document;
    if (!doc) throw new Error('A document is required to render rich text.');
    var remaining = Math.max(32, Math.min(2000, Number(options.maxNodes) || 1500));
    function element(tag, cls) {
      if (--remaining < 0) throw new Error('rich-budget');
      var node = doc.createElement(tag);
      if (cls) node.className = cls;
      return node;
    }
    function appendText(node, content) {
      if (!content) return;
      if (--remaining < 0) throw new Error('rich-budget');
      node.appendChild(doc.createTextNode(content));
    }
    function fragment() {
      return doc.createDocumentFragment();
    }
    function inline(parent, source, depth) {
      if ((depth || 0) > 6) {
        appendText(parent, source);
        return;
      }
      var re =
        /(`{1,3})([^`\n]+)\1|\*\*([^*\n]+)\*\*|!?\[([^\[\]\n]+)\]\(([^)\s]+)\)|(^|[\s(])_([^_\n]+)_(?=$|[\s.,)])|(^|[\s(])\*([^*\s][^*\n]*?)\*(?=$|[\s.,)])/g;
      var last = 0,
        match;
      while ((match = re.exec(source))) {
        appendText(parent, source.slice(last, match.index));
        var node;
        if (match[1]) {
          node = element('code');
          appendText(node, match[2]);
        } else if (match[3]) {
          node = element('strong');
          inline(node, match[3], (depth || 0) + 1);
        } else if (match[4]) {
          var safe = false;
          try {
            var url = new URL(match[5]);
            safe = url.protocol === 'https:' || url.protocol === 'http:';
          } catch (_) {}
          if (safe && match[0][0] !== '!') {
            node = element('a');
            node.href = match[5];
            node.rel = 'noreferrer noopener';
            node.target = '_blank';
            inline(node, match[4], (depth || 0) + 1);
          } else {
            appendText(parent, match[4]);
            last = re.lastIndex;
            continue;
          }
        } else {
          appendText(parent, match[6] || match[8] || '');
          node = element('em');
          inline(node, match[7] || match[9], (depth || 0) + 1);
        }
        parent.appendChild(node);
        last = re.lastIndex;
      }
      appendText(parent, source.slice(last));
    }
    function cells(line) {
      var result = [],
        cell = '',
        body = line.trim();
      if (body[0] === '|') body = body.slice(1);
      if (body.endsWith('|')) body = body.slice(0, -1);
      for (var n = 0; n < body.length; n++) {
        if (body[n] === '\\' && body[n + 1] === '|') {
          cell += '|';
          n++;
        } else if (body[n] === '|') {
          result.push(cell.trim());
          cell = '';
        } else cell += body[n];
      }
      result.push(cell.trim());
      if (result.length > 64) throw new Error('rich-budget');
      return result;
    }
    function row(line) {
      return /^\s*\|.*\|\s*$/.test(line || '');
    }
    function separator(line) {
      return (
        row(line) &&
        cells(line).every(function (cell) {
          return /^:?-+:?$/.test(cell);
        })
      );
    }
    function listMatch(line) {
      return /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(line || '');
    }
    function closing(line, marker) {
      var match = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      return match && match[1][0] === marker[0] && match[1].length >= marker.length;
    }
    function codeBox(body, language, quoteDepth) {
      var host = fragment();
      if (language) {
        var label = element('div', 'st-v-code-language');
        appendText(label, language.slice(0, 64));
        host.appendChild(label);
      }
      var pre = element('pre', 'st-v-md-code'),
        codeNode = element('code');
      var highlighted = code(body, {
        document: doc,
        maxNodes: Math.max(1, Math.min(512, Math.floor((remaining - 8) / 2))),
      });
      remaining -= highlighted.nodeCount;
      if (remaining < 0) throw new Error('rich-budget');
      codeNode.appendChild(highlighted);
      pre.appendChild(codeNode);
      host.appendChild(pre);
      for (var q = 0; q < Math.min(12, quoteDepth || 0); q++) {
        var quote = element('blockquote');
        quote.appendChild(host);
        host = quote;
      }
      return host;
    }
    function blocks(lines, depth, context) {
      if (depth > 12) throw new Error('rich-budget');
      var out = fragment(),
        i = 0;
      context = context || {};
      if (context.fence) {
        var carried = [],
          fence = context.fence;
        while (i < lines.length) {
          var clean = lines[i];
          for (var q = 0; q < (fence.quoteDepth || 0); q++)
            clean = clean.replace(/^\s*> ?/, '');
          if (closing(clean, fence.marker)) {
            i++;
            break;
          }
          carried.push(clean);
          i++;
        }
        out.appendChild(codeBox(carried.join('\n'), fence.language, fence.quoteDepth));
      }
      if (context.table && row(lines[i]) && !separator(lines[i])) {
        lines = lines.slice();
        lines.splice(i, 0, context.table.header, context.table.separator);
      }
      if (
        context.list &&
        i === 0 &&
        /^\s+\S/.test(lines[0] || '') &&
        !listMatch(lines[0])
      ) {
        var continuing = element(context.list.ordered ? 'ol' : 'ul'),
          item = element('li');
        if (context.list.ordered)
          continuing.setAttribute('start', String(context.list.start || 1));
        var continuation = [];
        while (i < lines.length && (/^\s+\S/.test(lines[i]) || !lines[i].trim()))
          continuation.push(lines[i++].trimStart());
        item.appendChild(blocks(continuation, depth + 1));
        continuing.appendChild(item);
        out.appendChild(continuing);
      }
      while (i < lines.length) {
        var line = lines[i];
        if (!line.trim()) {
          i++;
          continue;
        }
        var fence = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(line);
        if (fence) {
          var codeLines = [];
          i++;
          while (i < lines.length && !closing(lines[i], fence[1]))
            codeLines.push(lines[i++]);
          if (i < lines.length) i++;
          out.appendChild(codeBox(codeLines.join('\n'), fence[2]));
          continue;
        }
        if (/^\s*>/.test(line)) {
          var quoteLines = [];
          while (i < lines.length && /^\s*>/.test(lines[i]))
            quoteLines.push(lines[i++].replace(/^\s*> ?/, ''));
          var quote = element('blockquote'),
            callout = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/.exec(
              quoteLines[0] || '',
            );
          if (callout) {
            quote.className = 'st-v-callout st-v-callout-' + callout[1].toLowerCase();
            var label = element('strong');
            appendText(label, callout[1][0] + callout[1].slice(1).toLowerCase());
            quote.appendChild(label);
            quoteLines[0] = quoteLines[0].slice(callout[0].length);
          }
          quote.appendChild(blocks(quoteLines, depth + 1));
          out.appendChild(quote);
          continue;
        }
        if (row(line) && separator(lines[i + 1])) {
          var header = cells(line),
            aligns = cells(lines[i + 1]),
            data = [],
            width = header.length;
          i += 2;
          while (i < lines.length && row(lines[i])) {
            var values = cells(lines[i++]);
            width = Math.max(width, values.length);
            data.push(values);
          }
          var wrap = element('div', 'st-v-md-table-wrap'),
            table = element('table'),
            head = element('thead'),
            headRow = element('tr'),
            body = element('tbody');
          function tableCells(parent, values, tag) {
            for (var c = 0; c < width; c++) {
              var cell = element(tag);
              var align = aligns[c] || '';
              if (/^:.*:$/.test(align)) cell.setAttribute('align', 'center');
              else if (align.endsWith(':')) cell.setAttribute('align', 'right');
              else if (align.startsWith(':')) cell.setAttribute('align', 'left');
              inline(cell, values[c] || '');
              parent.appendChild(cell);
            }
          }
          tableCells(headRow, header, 'th');
          head.appendChild(headRow);
          table.appendChild(head);
          for (var values of data) {
            var tr = element('tr');
            tableCells(tr, values, 'td');
            body.appendChild(tr);
          }
          table.appendChild(body);
          wrap.appendChild(table);
          out.appendChild(wrap);
          continue;
        }
        var list = listMatch(line);
        if (list) {
          if (list[2].length > 12) throw new Error('rich-budget');
          var indent = list[1].length,
            ordered = /^\d/.test(list[2]),
            host = element(ordered ? 'ol' : 'ul');
          if (ordered) host.setAttribute('start', String(Number.parseInt(list[2], 10)));
          while (i < lines.length) {
            var match = listMatch(lines[i]);
            if (!match || match[1].length !== indent || /^\d/.test(match[2]) !== ordered)
              break;
            var item = element('li'),
              itemLines = [match[3]],
              strip = indent + match[2].length + 1;
            i++;
            while (i < lines.length) {
              var next = listMatch(lines[i]);
              if (next && next[1].length <= indent) break;
              if (lines[i].trim() && !/^\s/.test(lines[i])) break;
              if (
                !lines[i].trim() &&
                i + 1 < lines.length &&
                lines[i + 1].trim() &&
                !/^\s/.test(lines[i + 1])
              )
                break;
              itemLines.push(
                lines[i].slice(Math.min(strip, /^ */.exec(lines[i])[0].length)),
              );
              i++;
            }
            item.appendChild(blocks(itemLines, depth + 1));
            host.appendChild(item);
          }
          out.appendChild(host);
          continue;
        }
        var heading = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
        if (heading) {
          var h = element('h' + Math.min(6, heading[1].length + 1));
          inline(h, heading[2]);
          out.appendChild(h);
          i++;
          continue;
        }
        if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
          out.appendChild(element('hr'));
          i++;
          continue;
        }
        var paragraph = [line];
        i++;
        while (
          i < lines.length &&
          lines[i].trim() &&
          !/^(?:\s*>|\s*#{1,6}\s|\s*`{3,}|\s*~{3,})/.test(lines[i]) &&
          !listMatch(lines[i]) &&
          !(row(lines[i]) && separator(lines[i + 1]))
        )
          paragraph.push(lines[i++]);
        var p = element('p');
        inline(p, paragraph.join('\n'));
        out.appendChild(p);
      }
      return out;
    }
    function plain(reason) {
      var result = fragment(),
        pre = doc.createElement('pre');
      pre.className = 'st-v-rich-fallback';
      pre.setAttribute('data-rich-fallback', reason);
      pre.appendChild(doc.createTextNode(text));
      result.appendChild(pre);
      return result;
    }
    if (options.context && options.context.partialLine) return plain('continued-line');
    if (
      options.context &&
      ((options.context.fence && options.context.fence.oversized) ||
        (options.context.table && options.context.table.oversized))
    )
      return plain('oversized-continuation');
    if (text.length > 64 * 1024) return plain('oversized-block');
    try {
      return blocks(text.split('\n'), 0, options.context);
    } catch (_) {
      return plain('structure-budget');
    }
  }
  global.ShowtailRichText = { render: render, code: code };
})(typeof window !== 'undefined' ? window : globalThis);
