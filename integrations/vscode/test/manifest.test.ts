import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface LanguageModelToolContribution {
  name?: string;
  inputSchema?: {
    properties?: { action?: { enum?: string[] } };
    required?: string[];
  };
}

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
) as {
  engines?: { vscode?: string };
  activationEvents?: string[];
  capabilities?: {
    untrustedWorkspaces?: {
      supported?: string;
      description?: string;
      restrictedConfigurations?: string[];
    };
  };
  contributes?: { languageModelTools?: LanguageModelToolContribution[] };
  devDependencies?: { '@types/vscode'?: string };
};

describe('VS Code project-control manifest', () => {
  test('workspace trust describes native-history collection and protects CLI configuration', () => {
    const trust = manifest.capabilities?.untrustedWorkspaces;
    expect(trust?.supported).toBe('limited');
    expect(trust?.description).toContain('native conversation history');
    expect(trust?.description).toContain(
      'does not run the Showtail program in untrusted workspaces',
    );
    expect(trust?.description).not.toContain('file saves');
    expect(trust?.restrictedConfigurations).toContain('showtail.binaryPath');
  });

  test('targets the stable VS Code 1.95 language-model tool API', () => {
    expect(manifest.engines?.vscode).toBe('^1.95.0');
    expect(manifest.devDependencies?.['@types/vscode']).toBe('1.95.0');
    expect(manifest.activationEvents).toContain(
      'onLanguageModelTool:showtail_project_control',
    );
  });

  test('contributes the versioned project-control actions', () => {
    const tool = manifest.contributes?.languageModelTools?.find(
      (candidate) => candidate.name === 'showtail_project_control',
    );
    expect(tool).toBeDefined();
    expect(tool?.inputSchema?.properties?.action?.enum).toEqual([
      'report',
      'open_report',
      'status',
      'verify',
    ]);
    expect(tool?.inputSchema?.required).toEqual(['action']);
  });
});
