/** Literal paths mentioned by common shell write operations, never proof of a write. */
type Token = { text: string; operator?: boolean; quoted?: boolean };

/** Keep quoted data and here-doc bodies out of shell syntax recognition. */
function tokens(command: string): Token[] {
  const out: Token[] = [];
  const heredocs: string[] = [];
  let i = 0;
  const emit = (token: Token) => {
    if (out.at(-1)?.text === '<<' && !token.operator) heredocs.push(token.text);
    out.push(token);
  };
  while (i < command.length) {
    const c = command[i]!;
    if (c === '\r' || c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '\n') {
      emit({ text: '\n', operator: true });
      i++;
      for (const delimiter of heredocs.splice(0)) {
        while (i < command.length) {
          const end = command.indexOf('\n', i);
          const line = command.slice(i, end < 0 ? undefined : end).replace(/\r$/, '');
          i = end < 0 ? command.length : end + 1;
          if (line === delimiter) break;
        }
      }
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(command[i - 1]!))) {
      const end = command.indexOf('\n', i);
      i = end < 0 ? command.length : end;
      continue;
    }
    // PowerShell here-strings are values, including text that resembles commands.
    if (
      c === '@' &&
      /['"]/.test(command[i + 1] ?? '') &&
      /\r?\n/.test(command.slice(i + 2, i + 4))
    ) {
      const quote = command[i + 1]!;
      const end = command.indexOf('\n' + quote + '@', i + 2);
      i = end < 0 ? command.length : end + 3;
      emit({ text: '', quoted: true });
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let text = '';
      i++;
      while (i < command.length) {
        if (command[i] === quote) {
          if (quote === "'" && command[i + 1] === quote) {
            text += quote;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if ((command[i] === '\\' || command[i] === '`') && command[i + 1] === quote) {
          text += quote;
          i += 2;
        } else text += command[i++]!;
      }
      emit({ text, quoted: true });
      continue;
    }
    if (/[;|&<>]/.test(c)) {
      const doubled = command[i + 1] === c && /[|&<>]/.test(c);
      emit({ text: doubled ? c + c : c, operator: true });
      i += doubled ? 2 : 1;
      continue;
    }
    const start = i;
    while (i < command.length && !/[\s'";|&<>]/.test(command[i]!)) i++;
    emit({ text: command.slice(start, i) });
  }
  return out;
}

function literal(token: Token | undefined): string | undefined {
  if (!token || token.operator || !token.text || /[$%`*?\[\]{}()\r\n]/.test(token.text))
    return;
  if (!token.quoted && token.text.includes(',')) return;
  if (/^(?:\/dev\/(?:null|stdout|stderr)|nul)$/i.test(token.text)) return;
  return token.text;
}

/**
 * Conservative syntax-only hints. No shell is run, variables are not expanded,
 * and filesystem state is not consulted. Conditional or failed commands can
 * mention these paths without changing them; callers must retain that uncertainty.
 */
export function shellWritePaths(command: string): string[] {
  const found = new Set<string>();
  const add = (token: Token | undefined) => {
    const path = literal(token);
    if (path) found.add(path);
  };
  const parts = tokens(command);
  let segment: Token[] = [];
  const inspect = () => {
    const name = segment[0]?.quoted ? '' : segment[0]?.text.toLowerCase();
    if (
      name &&
      /^(?:set-content|add-content|out-file|tee-object|remove-item|move-item|copy-item)$/.test(
        name,
      )
    ) {
      const flag = segment.findIndex(
        (t) => !t.quoted && /^-(?:literalpath|filepath|path)$/i.test(t.text),
      );
      if (name !== 'copy-item') {
        if (flag >= 0) add(segment[flag + 1]);
        else if (segment[1] && !segment[1].text.startsWith('-')) add(segment[1]);
      }
      if (name === 'move-item' || name === 'copy-item') {
        const destination = segment.findIndex(
          (token) => !token.quoted && /^-destination$/i.test(token.text),
        );
        if (destination >= 0) add(segment[destination + 1]);
      }
    } else if (name === 'rm' || name === 'touch') {
      for (const token of segment.slice(1)) if (!token.text.startsWith('-')) add(token);
    } else if (name === 'mv' || name === 'cp') {
      const paths = segment
        .slice(1)
        .filter((token) => !token.operator && !token.text.startsWith('-'));
      if (paths.length === 2) {
        if (name === 'mv') add(paths[0]);
        add(paths[1]);
      }
    } else if (name === 'tee') {
      add(segment.find((t, index) => index > 0 && !t.text.startsWith('-')));
    } else if (
      (name === 'sed' || name === 'perl') &&
      segment.some((t) => /^-i/.test(t.text))
    ) {
      add(segment.at(-1));
    }
    segment = [];
  };
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i]!;
    if (token.operator && [';', '\n', '|', '||', '&&', '&'].includes(token.text)) {
      inspect();
      continue;
    }
    if (token.operator && (token.text === '>' || token.text === '>>')) add(parts[i + 1]);
    segment.push(token);
  }
  inspect();
  return [...found];
}
