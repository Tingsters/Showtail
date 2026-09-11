import {
  projectCatalogResolution,
  resolveProjectSelector,
  type ProjectResolution,
} from '../core/projectCatalog.ts';
import { emitJson } from '../core/output.ts';

export interface ProjectsOptions {
  selector?: string;
  cwd?: string;
  json?: boolean;
  verboseJson?: boolean;
}

function printResolution(resolution: ProjectResolution): void {
  if (resolution.state === 'catalog') {
    const candidates = resolution.candidates ?? [];
    if (candidates.length === 0) {
      console.log('No validated Showtail projects are known on this machine.');
      return;
    }
    console.log('Known Showtail projects');
    for (const item of candidates) {
      console.log(`  ${item.displayName}  ${item.trailId}`);
      console.log(`    ${item.root}`);
    }
    return;
  }

  if (resolution.selection) {
    console.log(`${resolution.selection.displayName} (${resolution.selection.trailId})`);
    console.log(`  ${resolution.selection.root}`);
    console.log(`  selected by ${resolution.selection.evidence.join(', ')}`);
    return;
  }

  if (resolution.state === 'not-found') {
    console.log(`No live Showtail project matches "${resolution.selector ?? ''}".`);
    return;
  }

  console.log(
    resolution.state === 'conflict'
      ? 'That trail id is live in multiple folders; choose an exact path.'
      : 'Showtail needs a project confirmation.',
  );
  for (const item of resolution.candidates ?? []) {
    console.log(`  ${item.displayName}  ${item.trailId}`);
    console.log(`    ${item.root}`);
  }
}

/** List the bounded catalog or resolve one selector without changing any trail. */
export async function runProjects(options: ProjectsOptions = {}): Promise<void> {
  const resolution = options.selector
    ? resolveProjectSelector(options.selector, {
        cwd: options.cwd,
        verbose: options.verboseJson,
      })
    : projectCatalogResolution({
        cwd: options.cwd,
        verbose: options.verboseJson,
      });
  if (options.json) emitJson(resolution);
  else printResolution(resolution);
}
