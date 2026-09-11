const assert = require('node:assert/strict');
const vscode = require('vscode');

const EXTENSION_ID = 'Tingsters.showtail';
const COMMANDS = [
  'showtail.report',
  'showtail.openReport',
  'showtail.status',
  'showtail.verify',
];
const TOOL_NAME = 'showtail_project_control';

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
}

module.exports = { run };
