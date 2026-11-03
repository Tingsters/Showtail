const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const vscode = require('vscode');
const execute = promisify(execFile);

const EXTENSION_ID = 'Tingsters.showtail';
const COMMANDS = [
  'showtail.report',
  'showtail.openReport',
  'showtail.status',
  'showtail.verify',
];
const TOOL_NAME = 'showtail_project_control';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readHistory() {
  const { stdout } = await execute(
    process.env.SHOWTAIL_TEST_BUN,
    [process.env.SHOWTAIL_TEST_READER],
    {
      env: process.env,
      windowsHide: true,
      timeout: 15_000,
    },
  );
  return JSON.parse(stdout);
}

async function waitForHistory(predicate, label) {
  const deadline = Date.now() + 30_000;
  let state;
  do {
    state = await readHistory();
    if (predicate(state)) return state;
    await sleep(200);
  } while (Date.now() < deadline);
  assert.fail(`${label}; observed ${JSON.stringify(state)}`);
}

async function cli(args) {
  const { stdout } = await execute(process.env.SHOWTAIL_TEST_BINARY, args, {
    cwd: vscode.workspace.workspaceFolders[0].uri.fsPath,
    env: process.env,
    windowsHide: true,
    timeout: 30_000,
  });
  return JSON.parse(stdout);
}

async function waitForDrain() {
  const queue = path.join(process.env.SHOWTAIL_HOME, 'observations');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (
      !fs.existsSync(queue) ||
      fs
        .readdirSync(queue)
        .every((name) => !name.endsWith('.json') && name !== 'worker.lock')
    )
      return;
    await sleep(100);
  }
  assert.fail('native watcher collector did not drain and exit');
}

function workspaceChatDirectory() {
  const storage = path.join(
    process.env.SHOWTAIL_TEST_USER_DATA,
    'User',
    'workspaceStorage',
  );
  const entries = fs
    .readdirSync(storage, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  // The 1.95 host creates meta.json here; newer builds may also write
  // workspace.json. The isolated profile has exactly one open folder.
  const candidates = entries.map((entry) => path.join(storage, entry.name));
  assert.equal(
    candidates.length,
    1,
    'the isolated profile must contain exactly one workspace',
  );
  return path.join(candidates[0], 'chatSessions');
}

async function run() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} was not installed in the extension host`);

  await extension.activate();
  assert.equal(extension.isActive, true, `${EXTENSION_ID} did not activate`);

  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of COMMANDS) {
    assert.ok(commands.has(command), `${command} was not registered`);
  }

  const tool = vscode.lm.tools.find((candidate) => candidate.name === TOOL_NAME);
  assert.ok(tool, `${TOOL_NAME} was not registered with vscode.lm`);
  assert.ok(tool.inputSchema, `${TOOL_NAME} did not expose its input schema`);
  assert.ok(tool.tags.includes('showtail'), `${TOOL_NAME} did not expose its tags`);
  assert.equal(vscode.workspace.isTrusted, true);
  assert.equal(
    vscode.workspace.getConfiguration('showtail').get('binaryPath'),
    process.env.SHOWTAIL_TEST_BINARY,
  );

  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const protectedFiles = ['package.json', 'AGENTS.md', '.git/hooks/pre-commit'];
  const before = protectedFiles.map((file) =>
    fs.readFileSync(path.join(workspace, file), 'utf8'),
  );
  // Finish the extension's startup catch-up before writing any native data.
  // Later records must come from the watcher, not initial synchronization.
  const initial = await waitForHistory(
    (state) => !!state.health?.lastCheckedAt,
    'extension startup sync never completed',
  );
  assert.deepEqual(initial.records, []);

  const manual = path.join(workspace, 'manual-notes.txt');
  fs.writeFileSync(manual, 'A human-created file.\n');
  const document = await vscode.workspace.openTextDocument(manual);
  const editor = await vscode.window.showTextDocument(document);
  await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'A manual edit.\n'));
  await document.save();
  await sleep(900);
  assert.deepEqual(
    (await readHistory()).records,
    [],
    'manual saves must not become AI work',
  );

  const nativeSessionId = 'editor-watcher-fixture';
  const aiFile = path.join(workspace, 'fixture.ts');
  fs.writeFileSync(aiFile, 'export const answer = 42;\n');
  const prompts = [
    'Build the first fixture.\nKeep its initial prompt.',
    'Run the tests again.',
    'Run the tests again.',
  ];
  const chatDirectory = workspaceChatDirectory();
  fs.mkdirSync(chatDirectory, { recursive: true });
  const nativeFile = path.join(chatDirectory, `${nativeSessionId}.jsonl`);
  const request = (index) => ({
    requestId: `request-${index}`,
    timestamp: Date.now(),
    message: { text: prompts[index] },
    agent: { extensionId: { value: 'GitHub.copilot-chat' } },
    response: [
      { value: `Completed fixture turn ${index + 1}.` },
      ...(index === 0
        ? [
            {
              kind: 'textEditGroup',
              uri: { fsPath: aiFile },
              edits: [[{ text: 'export const answer = 42;\n', range: {} }]],
            },
          ]
        : []),
    ],
    result: { metadata: {} },
  });
  const promptsOf = (state) =>
    state.records
      .filter((record) => record.kind === 'prompt')
      .map((record) => record.text);
  const started = Date.now();
  fs.writeFileSync(
    nativeFile,
    JSON.stringify({
      kind: 0,
      v: { version: 3, sessionId: nativeSessionId, requests: [request(0)] },
    }) + '\n',
  );
  let state = await waitForHistory(
    (value) => promptsOf(value).length === 1,
    'native journal creation did not trigger collection',
  );
  assert.deepEqual(promptsOf(state), prompts.slice(0, 1));
  for (const index of [1, 2]) {
    fs.appendFileSync(
      nativeFile,
      JSON.stringify({ kind: 2, k: ['requests'], v: [request(index)] }) + '\n',
    );
    state = await waitForHistory(
      (value) => promptsOf(value).length === index + 1,
      `native append ${index} did not trigger collection`,
    );
    assert.deepEqual(promptsOf(state), prompts.slice(0, index + 1));
  }
  assert.equal(
    new Set(
      state.records
        .filter((record) => record.kind === 'prompt')
        .map((record) => record.sourceId),
    ).size,
    prompts.length,
  );
  assert.ok(
    state.records.every(
      (record) =>
        record.tool === 'github-copilot' && record.nativeSessionId === nativeSessionId,
    ),
  );
  assert.ok(
    state.records.every(
      (record) =>
        path.resolve(record.transcriptPath).toLowerCase() ===
        path.resolve(nativeFile).toLowerCase(),
    ),
  );
  assert.ok(
    !state.records.some((record) => record.payload.file === manual),
    'manual file was captured as an AI edit',
  );
  const applied = state.records.filter(
    (record) => record.kind === 'edit' && !record.payload.duplicateOf,
  );
  assert.deepEqual(
    applied.map((record) => record.payload.file),
    [aiFile],
  );
  await waitForDrain();
  state = await readHistory();

  // All assertions above preceded any test-driven sync or report command.
  const nativeBefore = fs.readFileSync(nativeFile, 'utf8');
  const report = await cli(['report', '--all', '--json', '--no-sync', '--no-open']);
  assert.ok(
    report.reportPath.startsWith(path.join(process.env.SHOWTAIL_HOME, 'reports')),
  );
  assert.ok(
    fs.readFileSync(report.reportPath, 'utf8').includes(prompts[0].split('\n')[0]),
  );
  assert.equal(
    fs.readFileSync(nativeFile, 'utf8'),
    nativeBefore,
    'report creation modified native history',
  );
  assert.equal((await cli(['verify', '--json'])).ok, true);
  const status = await cli(['status', '--json', '--tool', 'copilot']);
  assert.equal(status.pendingCaptures, 0);
  assert.deepEqual(status.issues, []);
  protectedFiles.forEach((file, index) =>
    assert.equal(fs.readFileSync(path.join(workspace, file), 'utf8'), before[index]),
  );
  assert.equal(fs.existsSync(path.join(workspace, '.showtail')), false);
  assert.equal(fs.existsSync(path.join(workspace, '.github')), false);

  await cli(['setup', '--off', '--json']);
  const beforePause = state.records.map((record) => record.id);
  fs.appendFileSync(
    nativeFile,
    JSON.stringify({
      kind: 2,
      k: ['requests'],
      v: [
        {
          requestId: 'paused-request',
          timestamp: Date.now(),
          message: { text: 'Do not capture paused work.' },
          response: [{ value: 'Paused work.' }],
          result: { metadata: {} },
        },
      ],
    }) + '\n',
  );
  await sleep(1200);
  await waitForDrain();
  assert.deepEqual(
    (await readHistory()).records.map((record) => record.id),
    beforePause,
    'the watcher captured work while paused',
  );

  fs.writeFileSync(
    path.join(process.env.SHOWTAIL_TEST_ROOT, 'watcher-result.json'),
    JSON.stringify(
      {
        coverage:
          'real editor watcher with recorded native history and compiled CLI; no live Copilot inference',
        editorVersion: vscode.version,
        passed: true,
        prompts: prompts.length,
        duplicatePromptPreserved: true,
        nativeCreateAndAppend: true,
        nativeEditCaptured: true,
        manualSaveIgnored: true,
        pausedCaptureExcluded: true,
        sourceIdentityPreserved: true,
        projectFilesPreserved: true,
        integrityPassed: true,
        milliseconds: Date.now() - started,
      },
      null,
      2,
    ),
  );
}

module.exports = { run };
