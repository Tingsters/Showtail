// Runs INSIDE a real VS Code extension host (see test/runSecurityHost.mjs). It checks the
// properties that stop a hostile repository from making the editor run its code:
//
//  1. `showtail.binaryPath` is machine-scoped, so a workspace's own settings cannot change it;
//  2. in an UNTRUSTED workspace the extension launches nothing;
//  3. in a trusted workspace it launches the `showtail` found on PATH, never a `showtail`
//     program planted inside the workspace (on Windows a bare command name is resolved
//     against the working directory first, and the extension's working directory is the
//     workspace).
//
// The expected trust state comes from SHOWTAIL_HOST_EXPECT ('trusted' | 'untrusted').
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'Tingsters.showtail';
const EXE = process.platform === 'win32' ? 'showtail.exe' : 'showtail';

// The editor reports `c:\x` where the runner wrote `C:\x`; compare real, case-normalised paths.
const same = (a, b) => {
  const norm = (p) => {
    let real = path.resolve(p);
    try {
      real = fs.realpathSync.native(real);
    } catch {
      // not on disk (e.g. a bare command name): compare as given
    }
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(200);
  }
  return predicate();
}

async function run() {
  const expect = process.env.SHOWTAIL_HOST_EXPECT;
  assert.ok(expect === 'trusted' || expect === 'untrusted', 'SHOWTAIL_HOST_EXPECT not set');
  const legitLog = path.join(process.env.SHOWTAIL_TEST_LEGIT_DIR, 'calls.log');
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const evilLog = path.join(workspace, 'calls.log');

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} was not loaded`);
  await extension.activate();
  assert.equal(extension.isActive, true);

  // The test's own premise: the editor's trust state is what the runner arranged.
  assert.equal(
    vscode.workspace.isTrusted,
    expect === 'trusted',
    `workspace trust was ${vscode.workspace.isTrusted}, expected ${expect}`,
  );

  // 1. The workspace's .vscode/settings.json points binaryPath at the planted program.
  //    A machine-scoped setting ignores it.
  const config = vscode.workspace.getConfiguration('showtail');
  const planted = path.join(workspace, EXE);
  const settingsFile = JSON.parse(
    fs.readFileSync(path.join(workspace, '.vscode', 'settings.json'), 'utf8'),
  );
  assert.ok(
    same(settingsFile['showtail.binaryPath'], planted),
    'the test workspace should try to point binaryPath at the planted program',
  );
  const effective = config.get('binaryPath');
  assert.ok(
    !same(String(effective), planted),
    `a workspace setting changed showtail.binaryPath to ${effective}`,
  );
  assert.equal(effective, 'showtail', 'binaryPath should keep its default');
  assert.equal(
    config.inspect('binaryPath').workspaceValue,
    undefined,
    'a machine-scoped setting must have no workspace value',
  );

  // Control (Windows): is the attack even possible in THIS editor? Launch the bare name from the
  // workspace, as the extension does, and see which program runs. This is informational: some
  // hosts opt out of the working-directory search (NoDefaultCurrentDirectoryInExePath), in which
  // case the planted program was never reachable this way and the checks below are defence in
  // depth. It is recorded so a reader knows what was actually exercised.
  let controlRan = 'not applicable (not Windows)';
  if (process.platform === 'win32') {
    fs.rmSync(evilLog, { force: true });
    fs.rmSync(legitLog, { force: true });
    const r = cp.spawnSync('showtail', ['control'], { cwd: workspace });
    controlRan = lines(evilLog).length > 0 ? 'PLANTED program ran (attack is possible here)'
      : lines(legitLog).length > 0 ? 'program on PATH ran (cwd search is disabled in this host)'
      : `nothing ran (status ${r.status}, ${r.error ? r.error.message : 'no error'})`;
  }
  fs.writeFileSync(path.join(process.env.SHOWTAIL_TEST_LEGIT_DIR, 'control.txt'),
    `${controlRan}
NoDefaultCurrentDirectoryInExePath=${process.env.NoDefaultCurrentDirectoryInExePath ?? '(unset)'}
`);
  fs.rmSync(evilLog, { force: true });
  fs.rmSync(legitLog, { force: true });

  // 2/3. Make the extension work: edit and save a file, which drives its capture path.
  const file = path.join(workspace, 'notes.txt');
  fs.writeFileSync(file, 'first\n');
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document);
  await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'edited\n'));
  await document.save();

  if (expect === 'untrusted') {
    await sleep(6000);
    assert.deepEqual(lines(legitLog), [], 'the extension ran showtail in an untrusted workspace');
    assert.deepEqual(lines(evilLog), [], 'the extension ran the planted program');
  } else {
    const ran = await waitFor(() => lines(legitLog).length > 0, 20000);
    assert.ok(ran, 'in a trusted workspace the extension never ran the showtail on PATH');
    assert.deepEqual(
      lines(evilLog),
      [],
      'the extension ran the program planted in the workspace instead of the one on PATH',
    );
  }
}

module.exports = { run };
