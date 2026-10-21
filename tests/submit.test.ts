import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { type GhRunner, repoFromPrUrl, runSubmit } from '../src/commands/submit.ts';
import { logEvent } from '../src/core/events.ts';
import { setKnownSecretValues } from '../src/core/knownSecrets.ts';
import { approvalCode, neutralize } from '../src/core/prComment.ts';
import { sanitizeReportData } from '../src/core/shareReport.ts';
import { buildReportData } from '../src/core/report.ts';
import { SUBMISSION_DIR, verifySubmission } from '../src/core/submission.ts';
import { pathsForRoot, readConfig, writeConfig } from '../src/core/storage.ts';
import { authorFor, cleanup, makeTempDir, runCli, spawnEnv } from './helpers.ts';

// Shapes no rule has ever heard of, so only the sharing-time layers can stop them.
const INVENTED_KEY = 'zqk_Zq8Xk2Lm9Pw4Rt7Vb3Nc6Hd1Fs5Gj0Ya1';
const PASSPHRASE = 'plain-english-passphrase-for-the-db';

afterEach(() => setKnownSecretValues(undefined));

/** A project whose capture-time redaction is OFF, i.e. a leak that got into the trail. */
async function leakyProject(): Promise<{
  dir: string;
  paths: ReturnType<typeof pathsForRoot>;
}> {
  const dir = makeTempDir();
  await runInit({ cwd: dir });
  const paths = pathsForRoot(dir);
  const config = readConfig(paths);
  config.settings.redact = { enabled: false };
  writeConfig(paths, config);
  const author = authorFor(paths);
  await logEvent(author, {
    type: 'prompt',
    text: `please wire up the api, my key is ${INVENTED_KEY} and the db passphrase is ${PASSPHRASE}. See ${dir}/src/app.py and ${homedir()}/notes.txt, ask @bob about #12`,
  });
  await logEvent(author, {
    type: 'ai_output',
    text: 'Done. I used the key from your message.',
  });
  return { dir, paths };
}

function allText(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out.join('\n');
}

function quiet<T>(
  fn: () => Promise<T>,
): Promise<{ result?: T; error?: unknown; out: string }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(' '));
  return fn()
    .then((result) => ({ result, out: lines.join('\n') }))
    .catch((error) => ({ error, out: lines.join('\n') }))
    .finally(() => {
      console.log = orig;
    });
}

describe('showtail submit', () => {
  test('a leak that slipped past capture still does not reach the submission', async () => {
    const { dir } = await leakyProject();
    try {
      setKnownSecretValues([PASSPHRASE]);
      const { result, error } = await quiet(() => runSubmit({ cwd: dir, sync: false }));
      expect(error).toBeUndefined();
      const text = allText(result!.dir);
      expect(text).not.toContain(INVENTED_KEY);
      expect(text).not.toContain('Zq8Xk2Lm9Pw4Rt7Vb3Nc6Hd1Fs5Gj0Ya1');
      expect(text).not.toContain(PASSPHRASE);
      // Machine paths are gone, the project path is generic.
      expect(text).not.toContain(dir);
      expect(text).not.toContain(homedir());
      expect(text).toContain('<project>');
      // The report is still a report.
      expect(readFileSync(join(result!.dir, 'report.md'), 'utf8')).toContain(
        'please wire up the api',
      );
      expect(result!.manifest.withheld.total).toBeGreaterThan(0);
    } finally {
      cleanup(dir);
    }
  });

  test('writes the four files, outside the private working trail', async () => {
    const { dir } = await leakyProject();
    try {
      const { result } = await quiet(() => runSubmit({ cwd: dir, sync: false }));
      expect(result!.dir).toBe(join(dir, SUBMISSION_DIR));
      for (const f of ['report.html', 'report.md', 'manifest.json', 'manifest.sig']) {
        expect(existsSync(join(result!.dir, f))).toBe(true);
      }
      expect(verifySubmission(result!.dir).ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test('is blocked, writing nothing, when the final scan still finds a secret', async () => {
    const { dir, paths } = await leakyProject();
    try {
      // A field passed through as-is carries a key: only the independent scan sees it.
      await logEvent(authorFor(paths), {
        type: 'ai_output',
        text: 'ok',
        model: 'sk-proj-abcdefghijklmnop1234',
      });
      const { error } = await quiet(() => runSubmit({ cwd: dir, sync: false }));
      expect((error as { code: number }).code).toBe(6);
      expect(String((error as Error).message)).toContain('not submitting');
      expect(String((error as Error).message)).not.toContain('abcdefghijklmnop1234');
      expect(existsSync(join(dir, SUBMISSION_DIR))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('a committed config cannot switch the sharing-time sanitiser off', async () => {
    const { dir } = await leakyProject(); // redact.enabled is false here
    try {
      const { result } = await quiet(() => runSubmit({ cwd: dir, sync: false }));
      expect(allText(result!.dir)).not.toContain('Zq8Xk2Lm9Pw4Rt7Vb3Nc6Hd1Fs5Gj0Ya1');
    } finally {
      cleanup(dir);
    }
  });
});

describe('tamper evidence', () => {
  test('editing a report, the manifest, or the signature is detected', async () => {
    const { dir } = await leakyProject();
    try {
      const { result } = await quiet(() => runSubmit({ cwd: dir, sync: false }));
      const sub = result!.dir;
      expect(verifySubmission(sub).ok).toBe(true);

      const html = readFileSync(join(sub, 'report.html'), 'utf8');
      writeFileSync(
        join(sub, 'report.html'),
        html.replace('please wire up', 'I wrote this myself'),
      );
      expect(verifySubmission(sub).problems.join(' ')).toContain(
        'report.html was changed',
      );
      writeFileSync(join(sub, 'report.html'), html);
      expect(verifySubmission(sub).ok).toBe(true);

      const manifest = readFileSync(join(sub, 'manifest.json'), 'utf8');
      writeFileSync(
        join(sub, 'manifest.json'),
        manifest.replace('"sessions"', '"sessionz"'),
      );
      expect(verifySubmission(sub).ok).toBe(false);
      writeFileSync(join(sub, 'manifest.json'), manifest);

      writeFileSync(join(sub, 'manifest.sig'), 'AAAA\n');
      expect(verifySubmission(sub).ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test('a secret slipped into report.md after signing is also reported', async () => {
    const { dir } = await leakyProject();
    try {
      const { result } = await quiet(() => runSubmit({ cwd: dir, sync: false }));
      const md = join(result!.dir, 'report.md');
      writeFileSync(md, readFileSync(md, 'utf8') + '\nPASSWORD=hunter22xyz\n');
      const check = verifySubmission(result!.dir);
      expect(check.ok).toBe(false);
      expect(check.problems.join(' ')).toContain(
        'still contains what looks like a secret',
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('submit --pr', () => {
  function fakeGh(visibility = 'PUBLIC'): {
    gh: GhRunner;
    calls: string[][];
    bodies: string[];
  } {
    const calls: string[][] = [];
    const bodies: string[] = [];
    const gh: GhRunner = (args, input) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          status: 0,
          stdout: JSON.stringify({ number: 7, url: 'https://github.com/acme/hw/pull/7' }),
          stderr: '',
        };
      }
      if (args[0] === 'repo' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ visibility }), stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'comment') {
        bodies.push(input ?? '');
        return {
          status: 0,
          stdout: 'https://github.com/acme/hw/pull/7#issuecomment-1\n',
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: 'unexpected' };
    };
    return { gh, calls, bodies };
  }
  const posted = (calls: string[][]) =>
    calls.filter((c) => c[0] === 'pr' && c[1] === 'comment');

  test('--preview shows the exact text and posts nothing', async () => {
    const { dir } = await leakyProject();
    try {
      const { gh, calls } = fakeGh();
      const { result, out } = await quiet(() =>
        runSubmit({ cwd: dir, sync: false, pr: true, preview: true, gh }),
      );
      expect(posted(calls)).toEqual([]);
      expect(out).toContain(result!.comment!);
      expect(out).toContain('public and permanent');
      expect(out).toContain(`--approve ${approvalCode(result!.comment!)}`);
    } finally {
      cleanup(dir);
    }
  });

  test('posting needs the approval code, and posts byte-for-byte what was previewed', async () => {
    const { dir } = await leakyProject();
    try {
      // Nothing previewed yet: --approve has nothing to post.
      const early = await quiet(() =>
        runSubmit({
          cwd: dir,
          sync: false,
          pr: true,
          approve: 'deadbeef',
          gh: fakeGh().gh,
        }),
      );
      expect(String((early.error as Error).message)).toContain('no previewed comment');

      // No preview and not interactive: refused (and nothing was posted).
      const none = fakeGh();
      const refused = await quiet(() =>
        runSubmit({ cwd: dir, sync: false, pr: true, gh: none.gh, interactive: false }),
      );
      expect(String((refused.error as Error).message)).toContain('--preview');
      expect(posted(none.calls)).toEqual([]);

      const preview = fakeGh();
      const first = await quiet(() =>
        runSubmit({ cwd: dir, sync: false, pr: true, preview: true, gh: preview.gh }),
      );
      const code = approvalCode(first.result!.comment!);

      // Wrong code: refused.
      const wrong = fakeGh();
      const bad = await quiet(() =>
        runSubmit({ cwd: dir, sync: false, pr: true, approve: 'deadbeef', gh: wrong.gh }),
      );
      expect(String((bad.error as Error).message)).toContain('different text');
      expect(posted(wrong.calls)).toEqual([]);

      // Right code: posted exactly once, with exactly the previewed text, and the
      // approval is spent (a second --approve has nothing left to post).
      const ok = fakeGh();
      const done = await quiet(() =>
        runSubmit({ cwd: dir, sync: false, pr: true, approve: code, gh: ok.gh }),
      );
      expect(done.error).toBeUndefined();
      expect(ok.bodies).toHaveLength(1);
      expect(ok.bodies[0]).toBe(first.result!.comment!);
      expect(done.result!.posted!.url).toContain('issuecomment');
      const again = fakeGh();
      const twice = await quiet(() =>
        runSubmit({ cwd: dir, sync: false, pr: true, approve: code, gh: again.gh }),
      );
      expect(String((twice.error as Error).message)).toContain('no previewed comment');
      expect(posted(again.calls)).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  test('editing the report after the preview voids the approval', async () => {
    const { dir } = await leakyProject();
    try {
      const first = await quiet(() =>
        runSubmit({ cwd: dir, sync: false, pr: true, preview: true, gh: fakeGh().gh }),
      );
      const code = approvalCode(first.result!.comment!);
      const md = join(dir, SUBMISSION_DIR, 'report.md');
      writeFileSync(md, readFileSync(md, 'utf8') + '\nsneaked in after review\n');
      const after = fakeGh();
      const res = await quiet(() =>
        runSubmit({ cwd: dir, sync: false, pr: true, approve: code, gh: after.gh }),
      );
      expect(String((res.error as Error).message)).toContain(
        'report changed since you previewed',
      );
      expect(posted(after.calls)).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  test('an interactive "no" posts nothing; "yes" posts', async () => {
    const { dir } = await leakyProject();
    try {
      const no = fakeGh();
      await quiet(() =>
        runSubmit({
          cwd: dir,
          sync: false,
          pr: true,
          gh: no.gh,
          interactive: true,
          confirm: async () => false,
        }),
      );
      expect(posted(no.calls)).toEqual([]);

      const yes = fakeGh();
      await quiet(() =>
        runSubmit({
          cwd: dir,
          sync: false,
          pr: true,
          gh: yes.gh,
          interactive: true,
          confirm: async () => true,
        }),
      );
      expect(posted(yes.calls)).toHaveLength(1);
    } finally {
      cleanup(dir);
    }
  });

  test('the comment is a summary: no secrets, no paths, no mentions, no raw HTML', async () => {
    const { dir } = await leakyProject();
    try {
      const { gh } = fakeGh();
      const { result } = await quiet(() =>
        runSubmit({ cwd: dir, sync: false, pr: true, preview: true, gh }),
      );
      const comment = result!.comment!;
      expect(comment).not.toContain('Zq8Xk2Lm9Pw4Rt7Vb3Nc6Hd1Fs5Gj0Ya1');
      expect(comment).not.toContain(PASSPHRASE);
      expect(comment).not.toContain(dir);
      expect(comment).not.toContain('@bob');
      expect(comment).not.toMatch(/#12\b/);
      expect(comment).toContain('Report fingerprint');
      expect(comment).toContain(`sha256:${result!.manifest.files['report.html']}`);
    } finally {
      cleanup(dir);
    }
  });

  test('a private repository is described as private', async () => {
    const { dir } = await leakyProject();
    try {
      const { gh } = fakeGh('PRIVATE');
      const { out } = await quiet(() =>
        runSubmit({ cwd: dir, sync: false, pr: true, preview: true, gh }),
      );
      expect(out).toContain('only people with access');
      expect(out).not.toContain('public and permanent');
    } finally {
      cleanup(dir);
    }
  });

  test('without gh it explains how to get it, and nothing is posted', async () => {
    const { dir } = await leakyProject();
    try {
      const gh: GhRunner = () => ({ status: 127, stdout: '', stderr: 'not found' });
      const { error } = await quiet(() =>
        runSubmit({ cwd: dir, sync: false, pr: true, gh }),
      );
      expect(String((error as Error).message)).toContain('cli.github.com');
    } finally {
      cleanup(dir);
    }
  });

  test('helpers: neutralize defuses mentions, issue links and HTML; repo parsing', () => {
    expect(neutralize('ping @alice about #34 <b>x</b>\nand `code`')).not.toMatch(
      /@alice|#34|<b>|\n|`/,
    );
    expect(repoFromPrUrl('https://github.com/acme/hw/pull/7')).toBe('acme/hw');
    expect(repoFromPrUrl('https://example.com/nope')).toBeUndefined();
  });
});

describe('the sanitised report data', () => {
  test('ids and hashes are kept; free text is cleaned; findings are labels only', async () => {
    const { dir, paths } = await leakyProject();
    try {
      const raw = buildReportData(paths);
      const share = sanitizeReportData(raw, dir);
      expect(share.findings).toEqual([]);
      expect(share.data.turns[0]!.prompt.id).toBe(raw.turns[0]!.prompt.id);
      expect(share.data.turns[0]!.prompt.text).not.toContain(INVENTED_KEY);
      expect(share.withheld).toBeGreaterThan(0);
      expect(JSON.stringify(share.byLabel)).not.toContain(INVENTED_KEY);
    } finally {
      cleanup(dir);
    }
  });
});

describe('the real CLI', () => {
  test('submit then verify-submission; a tampered file fails with exit 3', async () => {
    const { dir } = await leakyProject();
    try {
      const env = spawnEnv();
      const made = runCli(dir, ['submit', '--no-sync'], { env });
      expect(made.code).toBe(0);
      expect(made.stdout).toContain('Report ready');
      expect(made.stdout).toContain('independent scan');
      expect(runCli(dir, ['verify-submission'], { env }).code).toBe(0);

      const sub = join(dir, SUBMISSION_DIR);
      writeFileSync(
        join(sub, 'report.md'),
        readFileSync(join(sub, 'report.md'), 'utf8') + '\nedited\n',
      );
      const bad = runCli(dir, ['verify-submission'], { env });
      expect(bad.code).toBe(3);
      expect(bad.stdout).toContain('NOT VERIFIED');
    } finally {
      cleanup(dir);
    }
  });
});

describe('report Markdown cannot be broken out of', () => {
  test('a diff containing a code fence gets a longer fence, and the report still renders', async () => {
    const { fenceFor } = await import('../src/core/report/markdown.ts');
    expect(fenceFor('plain')).toBe('```');
    expect(fenceFor('has ``` inside')).toBe('````');
    expect(fenceFor('a ```` b ``` c')).toBe('`````');

    const { renderMarkdown, renderHtml } = await import('../src/core/report.ts');
    const { dir, paths } = await leakyProject();
    try {
      const data = buildReportData(paths);
      data.turns[0]!.codeChanges.push({
        path: 'notes.md',
        timestamp: data.turns[0]!.prompt.timestamp,
        diff: '+```\n+![x](https://evil.example/track?q=1)\n+```\n+still inside the diff',
        diffLines: 4,
      });
      const md = renderMarkdown(data);
      expect(md).toContain('````diff');
      // The injected image sits between our fences, so it is code, not an <img>.
      const html = renderHtml(data);
      expect(html).not.toContain('<img src="https://evil.example');
    } finally {
      cleanup(dir);
    }
  });
});

describe('rotate advice', () => {
  test('is shown when something key-like was withheld, and not for personal data alone', async () => {
    const { withheldSecrets } = await import('../src/commands/submit.ts');
    expect(withheldSecrets({ total: 1, byLabel: { 'opaque-token': 1 } })).toBe(true);
    expect(withheldSecrets({ total: 1, byLabel: { 'api-key': 1 } })).toBe(true);
    expect(withheldSecrets({ total: 2, byLabel: { email: 1, phone: 1 } })).toBe(false);
    expect(withheldSecrets({ total: 0, byLabel: {} })).toBe(false);

    const { dir } = await leakyProject();
    try {
      const { out } = await quiet(() => runSubmit({ cwd: dir, sync: false }));
      expect(out).toContain('rotate it now');
      expect(out).toContain('AI provider');
      const json = await quiet(() => runSubmit({ cwd: dir, sync: false, json: true }));
      expect(json.out).toContain('"rotateAdvice": true');
    } finally {
      cleanup(dir);
    }
  });
});
