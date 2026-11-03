import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asArray, asString, prop } from '../util/parse.ts';

/** Structured native shell evidence only; never inspect or execute code-mode JS. */
export function codexCommandEvidence(item: unknown): {
  command: string;
  shellCommands: string[];
  cwd?: string;
} {
  const raw = prop(item, 'command');
  const argv = asArray(raw)?.filter(
    (value): value is string => typeof value === 'string',
  );
  const actions = asArray(prop(item, 'commandActions')) ?? [];
  let shellCommands = actions.flatMap((action) =>
    prop(action, 'type') === 'unknown' && asString(prop(action, 'command'))
      ? [asString(prop(action, 'command'))!]
      : [],
  );
  if (!shellCommands.length && argv?.length) {
    const executable = basename(argv[0]!.replace(/\\/g, '/'))
      .replace(/\.exe$/i, '')
      .toLowerCase();
    if (['pwsh', 'powershell', 'bash', 'sh', 'zsh', 'cmd'].includes(executable)) {
      const flag = argv.findIndex((arg) => /^(?:-command|-c|-lc|\/c)$/i.test(arg));
      if (flag >= 0 && argv[flag + 1]) shellCommands = [argv[flag + 1]!];
    }
  } else if (!shellCommands.length && typeof raw === 'string') {
    shellCommands = [raw];
  }
  let cwd = asString(prop(item, 'cwd'));
  if (cwd?.startsWith('file:')) {
    try {
      cwd = fileURLToPath(cwd);
    } catch {
      cwd = undefined;
    }
  }
  return {
    command:
      shellCommands.join('\n') ||
      asString(raw) ||
      (argv ? argv.map((arg) => JSON.stringify(arg)).join(' ') : ''),
    shellCommands,
    ...(cwd ? { cwd } : {}),
  };
}
