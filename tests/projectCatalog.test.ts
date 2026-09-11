import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  noteKnownProject,
  PROJECT_IDENTITY_CATALOG_VERSION,
  globalConfigPath,
  readGlobalConfig,
  writeGlobalConfig,
} from '../src/core/globalConfig.ts';
import {
  appendLedgerRecord,
  ensureLedgerSession,
  ensureLedgerSegments,
  markLedgerSegmentPlaced,
  setLedgerTurnProjectMetadata,
  writeLedgerSession,
} from '../src/core/ledger.ts';
import {
  assertProjectCommandIdentity,
  buildProjectCatalog,
  pinProjectCommandIdentity,
  refreshProjectIdentity,
  resolveProjectSelector,
} from '../src/core/projectCatalog.ts';
import { CONFIG_VERSION, pathsForRoot, writeJson } from '../src/core/storage.ts';
import { cleanup, makeTempDir } from './helpers.ts';

describe('metadata-first project catalog', () => {
  let previousHome: string | undefined;
  let dirs: string[];
  let home: string;

  beforeEach(() => {
    previousHome = process.env.SHOWTAIL_HOME;
    dirs = [];
    home = temp();
    process.env.SHOWTAIL_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.SHOWTAIL_HOME;
    else process.env.SHOWTAIL_HOME = previousHome;
    for (const dir of dirs.reverse()) cleanup(dir);
  });

  function temp(): string {
    const dir = makeTempDir();
    dirs.push(dir);
    return dir;
  }

  function trail(
    root: string,
    trailId: string,
    project: string,
    editBacked = false,
  ): void {
    const paths = pathsForRoot(root);
    mkdirSync(paths.base, { recursive: true });
    writeJson(paths.config, {
      version: CONFIG_VERSION,
      project,
      createdAt: '2026-09-11T00:00:00.000Z',
      anchor: root,
      anchorKind: editBacked ? 'edit' : 'explicit',
      initialization: {
        mode: 'automatic',
        evidence: editBacked ? 'edit' : 'explicit',
      },
      trailId,
      settings: { git: false },
    });
  }

  test('uses only Showtail-owned hints and revalidates every live config', () => {
    const caller = temp();
    const known = temp();
    const unregistered = join(home, 'nested', 'unregistered');
    mkdirSync(unregistered, { recursive: true });
    trail(known, 'trl_known', 'Known Project', true);
    trail(unregistered, 'trl_unregistered', 'Unregistered Project', true);
    noteKnownProject(known, 'trl_known');
    const before = readFileSync(globalConfigPath());

    const catalog = buildProjectCatalog({ cwd: caller });
    buildProjectCatalog({ cwd: caller });

    expect(catalog.projects.map((project) => project.trailId)).toEqual(['trl_known']);
    const exact = resolveProjectSelector(unregistered, { cwd: caller });
    expect(exact).toMatchObject({
      state: 'selected',
      selection: {
        trailId: 'trl_unregistered',
        root: unregistered,
        mode: 'authoritative',
        evidence: ['explicit-path', 'live-config'],
      },
    });
    expect(resolveProjectSelector(unregistered, { cwd: caller })).toEqual(exact);
    expect(readFileSync(globalConfigPath())).toEqual(before);
  });

  test('discovers a moved trail from an exact request attachment', () => {
    const caller = temp();
    const previousRoot = temp();
    const movedRoot = temp();
    const sourceDir = join(movedRoot, 'src');
    const attachedFile = join(sourceDir, 'word_sparkle.ts');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(attachedFile, 'export const sparkle = true;\n');
    trail(movedRoot, 'trl_attached_move', 'Word Sparkle');
    noteKnownProject(previousRoot, 'trl_attached_move', { editBacked: true });

    const session = ensureLedgerSession({
      tool: 'github-copilot',
      nativeSessionId: 'attachment-catalog-relocation',
      cwd: caller,
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'github-copilot',
      text: 'open the attached game',
    });
    const edit = appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'github-copilot',
      file: attachedFile,
      turnKey: prompt.id,
      sha256: 'a'.repeat(64),
    });
    expect(
      setLedgerTurnProjectMetadata(session.id, prompt.id, {
        nativeRequestId: 'request-with-project-attachment',
        attachments: [{ kind: 'file', path: attachedFile }],
      }),
    ).toBe(true);
    const before = readFileSync(globalConfigPath());

    const project = buildProjectCatalog({ cwd: caller }).projects.find(
      (candidate) => candidate.trailId === 'trl_attached_move',
    );
    expect(project).toMatchObject({
      root: movedRoot,
      liveRoots: [movedRoot],
      editBacked: true,
      conflict: false,
    });
    expect(project?.paths).toEqual(expect.arrayContaining([movedRoot, previousRoot]));
    expect(project?.sources).toEqual(
      expect.arrayContaining([
        'known-project',
        'ledger-attachment',
        'live-config',
        'edit-backed-provenance',
      ]),
    );
    expect(readFileSync(globalConfigPath())).toEqual(before);
    expect(
      refreshProjectIdentity(movedRoot, { expectedTrailId: 'trl_attached_move' }),
    ).toMatchObject({ trailId: 'trl_attached_move', root: movedRoot });
    expect(readGlobalConfig().projectCatalog?.byTrailId.trl_attached_move).toMatchObject({
      trailId: 'trl_attached_move',
      currentPath: movedRoot,
      previousPaths: [previousRoot],
      configuredName: 'Word Sparkle',
      entrypointBasenames: ['word_sparkle.ts'],
      editBacked: true,
      editReferences: [
        {
          ledgerId: session.id,
          nativeSessionId: 'attachment-catalog-relocation',
          recordId: edit.id,
          segmentId: expect.any(String),
          path: attachedFile,
          basename: 'word_sparkle.ts',
          sha256: 'a'.repeat(64),
        },
      ],
    });
  });

  test('excludes HOME from catalog matching but permits an exact path and safe refresh', () => {
    const caller = temp();
    const fakeHome = temp();
    const descendant = join(fakeHome, 'workspace');
    const descendantEdit = join(descendant, 'word_sparkle.ts');
    mkdirSync(descendant, { recursive: true });
    trail(fakeHome, 'trl_home', 'Home Project');
    noteKnownProject(fakeHome, 'trl_home', {
      configuredName: 'Home Project',
      entrypointBasenames: ['poison_sparkle.ts'],
      editReferences: [
        {
          ledgerId: 'led_poison_home',
          nativeSessionId: 'native_poison_home',
          segmentId: 'seg_poison_home',
          recordId: 'evt_poison_home',
          path: join(fakeHome, 'poison_sparkle.ts'),
          basename: 'poison_sparkle.ts',
        },
      ],
      editBacked: true,
    });

    const session = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'home-descendant-target',
      cwd: descendant,
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'edit the nested game',
    });
    const edit = appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'codex',
      file: descendantEdit,
      turnKey: prompt.id,
      sha256: 'd'.repeat(64),
    });
    expect(setLedgerTurnProjectMetadata(session.id, prompt.id, {})).toBe(true);
    const segment = ensureLedgerSegments(session.id).segments.find((item) =>
      item.recordIds.includes(edit.id),
    );
    if (!segment) throw new Error('Expected a HOME descendant segment');
    markLedgerSegmentPlaced(session.id, segment.id, 'trl_home', fakeHome);

    const previousUserProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = fakeHome;
    try {
      expect(buildProjectCatalog({ cwd: caller }).projects).toEqual([]);
      expect(resolveProjectSelector('Home Project', { cwd: caller }).state).toBe(
        'not-found',
      );
      expect(resolveProjectSelector(fakeHome, { cwd: caller })).toMatchObject({
        state: 'selected',
        selection: {
          trailId: 'trl_home',
          root: fakeHome,
          mode: 'authoritative',
          evidence: ['explicit-path', 'live-config'],
        },
      });

      refreshProjectIdentity(fakeHome, { expectedTrailId: 'trl_home' });
      const config = readGlobalConfig();
      expect(
        config.knownProjects?.find((item) => item.trailId === 'trl_home'),
      ).not.toHaveProperty('editBacked');
      expect(config.projectCatalog?.byTrailId.trl_home).not.toHaveProperty(
        'entrypointBasenames',
      );
      expect(config.projectCatalog?.byTrailId.trl_home).not.toHaveProperty(
        'previousEntrypointBasenames',
      );
      expect(config.projectCatalog?.byTrailId.trl_home).not.toHaveProperty(
        'editReferences',
      );
      expect(config.projectCatalog?.byTrailId.trl_home).not.toHaveProperty('editBacked');
    } finally {
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });

  test('accepts only safe witnessed ledger edit paths as entrypoint evidence', () => {
    const caller = temp();
    const project = temp();
    const validFile = join(project, 'word_sparkle.ts');
    trail(project, 'trl_safe_edits', 'Safe Edits');
    writeFileSync(validFile, 'export const sparkle = true;\n');
    noteKnownProject(project, 'trl_safe_edits');

    const session = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'safe-catalog-edits',
      cwd: project,
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'update the game',
    });
    const edits = [
      { file: validFile },
      { file: join(project, 'retired_sparkle.ts'), deleted: true },
      { file: join('src', 'relative.ts'), sha256: 'e'.repeat(64) },
      { file: join(project, '--json'), sha256: 'e'.repeat(64) },
      { file: join(project, 'str: output.ts'), sha256: 'e'.repeat(64) },
      { file: join(project, 'const fake.ts'), sha256: 'e'.repeat(64) },
      { file: join(project, '+++ patch.ts'), deleted: true },
      { file: join(project, 'bad\npath.ts'), sha256: 'e'.repeat(64) },
      { file: join(project, 'prose output'), sha256: 'not-a-sha256' },
    ];
    for (const input of edits) {
      appendLedgerRecord(session.id, {
        kind: 'edit',
        tool: 'codex',
        turnKey: prompt.id,
        ...input,
      });
    }
    expect(setLedgerTurnProjectMetadata(session.id, prompt.id, {})).toBe(true);

    const entry = buildProjectCatalog({ cwd: caller }).projects.find(
      (item) => item.trailId === 'trl_safe_edits',
    );
    expect(entry).toMatchObject({ editBacked: true });
    expect(entry?.aliases).toContain('word_sparkle');
    expect(entry?.aliases).toContain('retired_sparkle');
    for (const alias of [
      'relative',
      '--json',
      'str: output',
      'const fake',
      '+++ patch',
    ]) {
      expect(entry?.aliases).not.toContain(alias);
    }

    refreshProjectIdentity(project, { expectedTrailId: 'trl_safe_edits' });
    expect(readGlobalConfig().projectCatalog?.byTrailId.trl_safe_edits).toMatchObject({
      entrypointBasenames: ['word_sparkle.ts', 'retired_sparkle.ts'],
      editReferences: [
        expect.objectContaining({ path: validFile, basename: 'word_sparkle.ts' }),
        expect.objectContaining({
          path: join(project, 'retired_sparkle.ts'),
          basename: 'retired_sparkle.ts',
        }),
      ],
    });
    expect(
      readGlobalConfig().projectCatalog?.byTrailId.trl_safe_edits?.editReferences,
    ).toHaveLength(2);
  });

  test('uses only the corrected edit as project identity evidence', () => {
    const caller = temp();
    const fairy = temp();
    const word = temp();
    const obsoleteFile = join(fairy, 'fairy_spellbook.ts');
    const correctedFile = join(word, 'word_sparkle.ts');
    trail(fairy, 'trl_sparkle_fairy', 'Sparkle Fairy');
    trail(word, 'trl_sparkle_word', 'Sparkle Word');
    writeFileSync(obsoleteFile, 'export const fairy = true;\n');
    writeFileSync(correctedFile, 'export const word = true;\n');
    noteKnownProject(fairy, 'trl_sparkle_fairy');
    noteKnownProject(word, 'trl_sparkle_word');

    const session = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'corrected-catalog-edit',
      cwd: caller,
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'update the sparkle word game',
    });
    const obsolete = appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'codex',
      file: obsoleteFile,
      turnKey: prompt.id,
      sourceId: 'corrected-catalog-source',
      sha256: 'a'.repeat(64),
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'codex',
      file: correctedFile,
      turnKey: prompt.id,
      sourceId: obsolete.sourceId,
      supersedesRecordId: obsolete.id,
      sha256: 'b'.repeat(64),
    });
    expect(setLedgerTurnProjectMetadata(session.id, prompt.id, {})).toBe(true);

    const projects = buildProjectCatalog({ cwd: caller }).projects;
    const fairyEntry = projects.find(
      (project) => project.trailId === 'trl_sparkle_fairy',
    );
    const wordEntry = projects.find((project) => project.trailId === 'trl_sparkle_word');
    expect(fairyEntry).toMatchObject({ editBacked: false });
    expect(fairyEntry?.aliases).not.toContain('fairy_spellbook');
    expect(fairyEntry?.sources).not.toContain('ledger-edit-reference');
    expect(wordEntry).toMatchObject({ editBacked: true });
    expect(wordEntry?.aliases).toContain('word_sparkle');
    expect(wordEntry?.sources).toContain('ledger-edit-reference');
  });

  test('uses only a ledger-revalidated persisted edit reference after a move', () => {
    const caller = temp();
    const previousRoot = temp();
    const currentRoot = temp();
    const entrypoint = join(currentRoot, 'word_sparkle.py');
    trail(currentRoot, 'trl_persisted_move', 'Renamed Notebook');
    writeFileSync(entrypoint, 'print("sparkle")\n');

    const session = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'native-persisted-move',
      cwd: caller,
    });
    const prompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'update the word game',
    });
    const edit = appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'codex',
      file: entrypoint,
      turnKey: prompt.id,
      sha256: 'b'.repeat(64),
    });
    expect(setLedgerTurnProjectMetadata(session.id, prompt.id, {})).toBe(true);
    const segment = ensureLedgerSegments(session.id).segments.find((item) =>
      item.recordIds.includes(edit.id),
    );
    if (!segment) throw new Error('Expected a persisted edit segment');

    writeGlobalConfig({
      version: 1,
      knownProjects: [
        {
          trailId: 'trl_persisted_move',
          path: currentRoot,
          lastSeenAt: '2026-09-10T00:00:00.000Z',
        },
      ],
      projectCatalog: {
        version: PROJECT_IDENTITY_CATALOG_VERSION,
        byTrailId: {
          trl_persisted_move: {
            trailId: 'trl_persisted_move',
            currentPath: previousRoot,
            configuredName: 'Word Sparkle',
            currentFolderBasename: 'word_sparkle_old',
            entrypointBasenames: ['word_sparkle.py'],
            editReferences: [
              {
                ledgerId: session.id,
                nativeSessionId: session.nativeSessionId,
                recordId: edit.id,
                segmentId: segment.id,
                path: entrypoint,
                basename: 'word_sparkle.py',
                sha256: 'b'.repeat(64),
              },
            ],
            editBacked: true,
            lastSeenAt: '2026-09-10T00:00:00.000Z',
          },
        },
      },
    });
    const before = readFileSync(globalConfigPath());

    expect(resolveProjectSelector('open sparkle word', { cwd: caller })).toMatchObject({
      state: 'selected',
      selection: {
        trailId: 'trl_persisted_move',
        root: currentRoot,
        mode: 'corroborated',
      },
    });
    expect(
      buildProjectCatalog({ cwd: caller }).projects.find(
        (project) => project.trailId === 'trl_persisted_move',
      )?.sources,
    ).toContain('identity-edit-reference');
    expect(readFileSync(globalConfigPath())).toEqual(before);

    refreshProjectIdentity(currentRoot, { expectedTrailId: 'trl_persisted_move' });
    expect(readGlobalConfig().projectCatalog?.byTrailId.trl_persisted_move).toMatchObject(
      {
        currentPath: currentRoot,
        previousPaths: [previousRoot],
        configuredName: 'Renamed Notebook',
        previousConfiguredNames: ['Word Sparkle'],
        currentFolderBasename: expect.any(String),
        previousFolderBasenames: ['word_sparkle_old'],
        entrypointBasenames: ['word_sparkle.py'],
        editBacked: true,
        editReferences: [
          expect.objectContaining({
            ledgerId: session.id,
            recordId: edit.id,
            segmentId: segment.id,
          }),
        ],
      },
    );
  });

  test('selects a reordered complete project name only with edit provenance', () => {
    const caller = temp();
    const word = temp();
    const fairy = temp();
    trail(word, 'trl_word', 'Word Sparkle', true);
    trail(fairy, 'trl_fairy', 'Fairy Sparkle', true);
    noteKnownProject(word, 'trl_word');
    noteKnownProject(fairy, 'trl_fairy');

    const selected = resolveProjectSelector('my sparkle word game', { cwd: caller });
    expect(selected).toMatchObject({
      state: 'selected',
      selection: {
        trailId: 'trl_word',
        root: word,
        mode: 'corroborated',
        evidence: ['complete-name', 'edit-backed-provenance', 'live-config'],
        crossWorkspace: true,
      },
    });
    const ambiguous = resolveProjectSelector('sparkle game', { cwd: caller });
    expect(ambiguous.state).toBe('ambiguous');
    expect(ambiguous.candidates?.map((candidate) => candidate.trailId).sort()).toEqual([
      'trl_fairy',
      'trl_word',
    ]);
  });

  test('does not let a one-word Game alias block a specific complete name', () => {
    const caller = temp();
    const word = temp();
    const game = temp();
    trail(word, 'trl_word_specific', 'Word Sparkle', true);
    trail(game, 'trl_game_generic', 'Game', true);
    noteKnownProject(word, 'trl_word_specific');
    noteKnownProject(game, 'trl_game_generic');

    expect(
      resolveProjectSelector('open my sparkle word game', { cwd: caller }),
    ).toMatchObject({
      state: 'selected',
      selection: {
        trailId: 'trl_word_specific',
        root: word,
        mode: 'corroborated',
      },
    });
  });

  test('keeps entrypoint-only aliases out of a stronger name ambiguity', () => {
    const caller = temp();
    const word = temp();
    const fairy = temp();
    const fantasy = temp();
    const platformer = temp();
    const game = temp();
    const fantasyEdit = join(fantasy, 'sparkle_game.ts');
    const platformerEdit = join(platformer, 'game_manager.ts');
    trail(word, 'trl_word_ranked', 'Word Sparkle', true);
    trail(fairy, 'trl_fairy_ranked', 'Fairy Sparkle', true);
    trail(fantasy, 'trl_fantasy_ranked', 'Fantasy Maze', true);
    trail(platformer, 'trl_platformer_ranked', 'Medieval Platformer', true);
    writeFileSync(fantasyEdit, 'export const game = true;\n');
    writeFileSync(platformerEdit, 'export const manager = true;\n');
    noteKnownProject(word, 'trl_word_ranked');
    noteKnownProject(fairy, 'trl_fairy_ranked');
    noteKnownProject(fantasy, 'trl_fantasy_ranked');
    noteKnownProject(platformer, 'trl_platformer_ranked');

    const session = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'entrypoint-ranking',
      cwd: caller,
    });
    const fantasyPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'edit the fantasy game',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'codex',
      file: fantasyEdit,
      turnKey: fantasyPrompt.id,
      sha256: 'a'.repeat(64),
    });
    const platformerPrompt = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'edit the platformer manager',
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'codex',
      file: platformerEdit,
      turnKey: platformerPrompt.id,
      sha256: 'b'.repeat(64),
    });
    expect(setLedgerTurnProjectMetadata(session.id, fantasyPrompt.id, {})).toBe(true);
    expect(setLedgerTurnProjectMetadata(session.id, platformerPrompt.id, {})).toBe(true);
    ensureLedgerSegments(session.id);

    const before = readFileSync(globalConfigPath());
    const resolution = resolveProjectSelector('sparkle game', { cwd: caller });

    expect(resolution.state).toBe('ambiguous');
    expect(resolution.candidates?.map((item) => item.trailId).sort()).toEqual([
      'trl_fairy_ranked',
      'trl_word_ranked',
    ]);
    expect(
      resolveProjectSelector('sparkle game manager', {
        cwd: caller,
      })
        .candidates?.map((item) => item.trailId)
        .sort(),
    ).toEqual(['trl_fairy_ranked', 'trl_word_ranked']);
    expect(resolveProjectSelector('game manager', { cwd: caller })).toMatchObject({
      state: 'confirmation-required',
      candidates: [expect.objectContaining({ trailId: 'trl_platformer_ranked' })],
    });
    expect(readFileSync(globalConfigPath())).toEqual(before);

    const generic = resolveProjectSelector('game', { cwd: caller });
    expect(generic.state).toBe('ambiguous');
    expect(generic.candidates?.map((item) => item.trailId).sort()).toEqual([
      'trl_fantasy_ranked',
      'trl_platformer_ranked',
    ]);
    expect(readFileSync(globalConfigPath())).toEqual(before);

    trail(game, 'trl_game_ranked', 'Game', true);
    noteKnownProject(game, 'trl_game_ranked');
    const beforeNamedGame = readFileSync(globalConfigPath());
    expect(resolveProjectSelector('game', { cwd: caller })).toMatchObject({
      state: 'confirmation-required',
      candidates: [expect.objectContaining({ trailId: 'trl_game_ranked' })],
    });
    expect(readFileSync(globalConfigPath())).toEqual(beforeNamedGame);
  });

  test('requires confirmation when a complete name lacks edit provenance', () => {
    const caller = temp();
    const project = temp();
    trail(project, 'trl_planning', 'Planning Notebook');
    noteKnownProject(project, 'trl_planning');

    const resolution = resolveProjectSelector('open my planning notebook', {
      cwd: caller,
    });

    expect(resolution.state).toBe('confirmation-required');
    expect(resolution.candidates).toEqual([
      expect.objectContaining({ trailId: 'trl_planning', root: project }),
    ]);
  });

  test('keeps edit provenance scoped to the edited target after a path rebase', () => {
    const caller = temp();
    const alpha = temp();
    const beta = temp();
    const previousAlpha = join(caller, 'moved-alpha');
    trail(alpha, 'trl_alpha', 'Alpha Project');
    trail(beta, 'trl_beta', 'Beta Project');
    noteKnownProject(alpha, 'trl_alpha');
    noteKnownProject(beta, 'trl_beta');

    const session = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'mixed-project-provenance',
      cwd: caller,
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'codex',
      file: join(previousAlpha, 'alpha.ts'),
      sha256: 'c'.repeat(64),
    });
    session.status = 'placed';
    session.targets = [
      { trailId: 'trl_alpha', path: alpha },
      { trailId: 'trl_beta', path: beta },
    ];
    session.pathRebases = [{ fromRoot: previousAlpha, toRoot: alpha }];
    writeLedgerSession(session);

    const catalog = buildProjectCatalog({ cwd: caller });
    expect(
      catalog.projects.find((project) => project.trailId === 'trl_alpha'),
    ).toMatchObject({ editBacked: true });
    expect(
      catalog.projects.find((project) => project.trailId === 'trl_beta'),
    ).toMatchObject({
      editBacked: false,
    });
    expect(resolveProjectSelector('Beta Project', { cwd: caller }).state).toBe(
      'confirmation-required',
    );
  });

  test('does not borrow another segment or session target for edit evidence', () => {
    const caller = temp();
    const alpha = temp();
    const beta = temp();
    const nestedBoundary = join(alpha, 'nested-repository');
    const editPath = join(nestedBoundary, 'alpha_secret.ts');
    mkdirSync(join(nestedBoundary, '.git'), { recursive: true });
    trail(alpha, 'trl_segment_alpha', 'Segment Alpha');
    trail(beta, 'trl_segment_beta', 'Segment Beta');
    noteKnownProject(alpha, 'trl_segment_alpha');
    noteKnownProject(beta, 'trl_segment_beta');

    const session = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'segment-target-isolation',
      cwd: caller,
    });
    const promptA = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'work on alpha',
    });
    const promptB = appendLedgerRecord(session.id, {
      kind: 'prompt',
      tool: 'codex',
      text: 'work on beta',
    });
    const editB = appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'codex',
      file: editPath,
      turnKey: promptB.id,
      sha256: 'f'.repeat(64),
    });
    expect(setLedgerTurnProjectMetadata(session.id, promptA.id, {})).toBe(true);
    expect(setLedgerTurnProjectMetadata(session.id, promptB.id, {})).toBe(true);
    const document = ensureLedgerSegments(session.id);
    const segmentA = document.segments.find((segment) =>
      segment.recordIds.includes(promptA.id),
    );
    const segmentB = document.segments.find((segment) =>
      segment.recordIds.includes(editB.id),
    );
    if (!segmentA || !segmentB) throw new Error('Expected two isolated segments');
    markLedgerSegmentPlaced(session.id, segmentA.id, 'trl_segment_alpha', alpha);
    markLedgerSegmentPlaced(session.id, segmentB.id, 'trl_segment_beta', beta);

    const catalog = buildProjectCatalog({ cwd: caller });
    expect(
      catalog.projects.find((project) => project.trailId === 'trl_segment_alpha'),
    ).toMatchObject({ editBacked: false });
    expect(
      catalog.projects.find((project) => project.trailId === 'trl_segment_beta'),
    ).toMatchObject({ editBacked: false });
    expect(
      catalog.projects.find((project) => project.trailId === 'trl_segment_alpha')
        ?.aliases,
    ).not.toContain('alpha_secret');
  });

  test('prefers the nearest live trail over a broad legacy session target', () => {
    const caller = temp();
    const broad = temp();
    const nested = join(broad, 'nested-project');
    const editPath = join(nested, 'nested_entry.ts');
    trail(broad, 'trl_broad', 'Broad Project');
    trail(nested, 'trl_nested', 'Nested Project');
    noteKnownProject(broad, 'trl_broad');
    noteKnownProject(nested, 'trl_nested');

    const session = ensureLedgerSession({
      tool: 'codex',
      nativeSessionId: 'nearest-live-trail',
      cwd: caller,
    });
    appendLedgerRecord(session.id, {
      kind: 'edit',
      tool: 'codex',
      file: editPath,
      sha256: '1'.repeat(64),
    });
    session.status = 'placed';
    session.targets = [{ trailId: 'trl_broad', path: broad }];
    writeLedgerSession(session);

    const catalog = buildProjectCatalog({ cwd: caller });
    expect(
      catalog.projects.find((project) => project.trailId === 'trl_nested'),
    ).toMatchObject({ editBacked: true });
    expect(
      catalog.projects.find((project) => project.trailId === 'trl_broad'),
    ).toMatchObject({ editBacked: false });
  });

  test('ignores unvalidated persisted entrypoints and scrubs them on refresh', () => {
    const caller = temp();
    const project = temp();
    trail(project, 'trl_unvalidated_ref', 'Neutral Project');
    writeGlobalConfig({
      version: 1,
      knownProjects: [
        {
          trailId: 'trl_unvalidated_ref',
          path: project,
          editBacked: true,
          lastSeenAt: '2026-09-10T00:00:00.000Z',
        },
      ],
      projectCatalog: {
        version: PROJECT_IDENTITY_CATALOG_VERSION,
        byTrailId: {
          trl_unvalidated_ref: {
            trailId: 'trl_unvalidated_ref',
            currentPath: project,
            configuredName: 'Neutral Project',
            currentFolderBasename: basename(project),
            entrypointBasenames: ['poison_sparkle.py'],
            previousEntrypointBasenames: ['older_poison_game.py'],
            editReferences: [
              {
                ledgerId: 'led_missing',
                nativeSessionId: 'native_missing',
                segmentId: 'seg_missing',
                recordId: 'evt_missing',
                path: join(project, 'poison_sparkle.py'),
                basename: 'poison_sparkle.py',
              },
            ],
            editBacked: true,
            lastSeenAt: '2026-09-10T00:00:00.000Z',
          },
        },
      },
    });
    const before = readFileSync(globalConfigPath());

    const entry = buildProjectCatalog({ cwd: caller }).projects.find(
      (item) => item.trailId === 'trl_unvalidated_ref',
    );
    expect(entry).toMatchObject({ editBacked: false });
    expect(entry?.aliases).not.toContain('poison_sparkle');
    expect(entry?.aliases).not.toContain('older_poison_game');
    expect(resolveProjectSelector('poison sparkle', { cwd: caller }).state).toBe(
      'not-found',
    );
    expect(readFileSync(globalConfigPath())).toEqual(before);

    refreshProjectIdentity(project, { expectedTrailId: 'trl_unvalidated_ref' });
    const sanitized = readGlobalConfig();
    expect(
      sanitized.knownProjects?.find((item) => item.trailId === 'trl_unvalidated_ref'),
    ).not.toHaveProperty('editBacked');
    expect(sanitized.projectCatalog?.byTrailId.trl_unvalidated_ref).not.toHaveProperty(
      'entrypointBasenames',
    );
    expect(sanitized.projectCatalog?.byTrailId.trl_unvalidated_ref).not.toHaveProperty(
      'previousEntrypointBasenames',
    );
    expect(sanitized.projectCatalog?.byTrailId.trl_unvalidated_ref).not.toHaveProperty(
      'editReferences',
    );
    expect(sanitized.projectCatalog?.byTrailId.trl_unvalidated_ref).not.toHaveProperty(
      'editBacked',
    );
  });

  test('does not transfer stale identity metadata to either live trail', () => {
    const replaced = temp();
    const oldLive = temp();
    trail(replaced, 'trl_new', 'New Identity');
    trail(oldLive, 'trl_old', 'Old Live');
    writeGlobalConfig({
      ...readGlobalConfig(),
      knownProjects: [
        {
          trailId: 'trl_old',
          path: replaced,
          editBacked: true,
          lastSeenAt: '2026-09-10T00:00:00.000Z',
        },
      ],
      projectCatalog: {
        version: PROJECT_IDENTITY_CATALOG_VERSION,
        byTrailId: {
          trl_old: {
            trailId: 'trl_old',
            currentPath: replaced,
            configuredName: 'Poison Sparkle',
            currentFolderBasename: 'poison_sparkle',
            entrypointBasenames: ['poison_sparkle.py'],
            editReferences: [
              {
                ledgerId: 'led_poison',
                nativeSessionId: 'native_poison',
                recordId: 'evt_poison',
                path: join(replaced, 'poison_sparkle.py'),
                basename: 'poison_sparkle.py',
              },
            ],
            editBacked: true,
            lastSeenAt: '2026-09-10T00:00:00.000Z',
          },
        },
      },
    });

    const before = readFileSync(globalConfigPath());
    const catalog = buildProjectCatalog({ cwd: oldLive });
    const old = catalog.projects.find((project) => project.trailId === 'trl_old');
    const newer = catalog.projects.find((project) => project.trailId === 'trl_new');

    expect(catalog.warnings).toHaveLength(2);
    expect(old).toMatchObject({ editBacked: false, paths: [oldLive] });
    expect(old?.aliases).not.toContain('New Identity');
    expect(old?.aliases).not.toContain('Poison Sparkle');
    expect(old?.aliases).not.toContain('poison_sparkle');
    expect(newer).toMatchObject({ editBacked: false, sources: ['live-config'] });
    expect(resolveProjectSelector('Poison Sparkle', { cwd: oldLive }).state).toBe(
      'not-found',
    );
    expect(readFileSync(globalConfigPath())).toEqual(before);
    refreshProjectIdentity(oldLive, { expectedTrailId: 'trl_old' });
    refreshProjectIdentity(replaced, { expectedTrailId: 'trl_new' });
    const persisted = readGlobalConfig().projectCatalog?.byTrailId;
    expect(persisted?.trl_old).toMatchObject({
      currentPath: oldLive,
      configuredName: 'Old Live',
    });
    expect(persisted?.trl_old).not.toHaveProperty('editBacked');
    expect(persisted?.trl_old).not.toHaveProperty('editReferences');
    expect(persisted?.trl_old).not.toHaveProperty('entrypointBasenames');
    expect(persisted?.trl_new).toMatchObject({
      currentPath: replaced,
      configuredName: 'New Identity',
    });
    expect(persisted?.trl_new).not.toHaveProperty('editBacked');
    expect(persisted?.trl_new).not.toHaveProperty('editReferences');
  });

  test('ignores and preserves a future persisted identity catalog version', () => {
    const caller = temp();
    const project = temp();
    trail(project, 'trl_future_safe', 'Future Safe');
    const futureCatalog = {
      version: 99,
      byTrailId: {
        trl_future_safe: {
          trailId: 'trl_future_safe',
          currentPath: project,
          configuredName: 'Poison Future Alias',
          currentFolderBasename: 'poison_future_alias',
          editBacked: true,
          lastSeenAt: '2026-09-10T00:00:00.000Z',
        },
      },
    };
    writeGlobalConfig({
      version: 1,
      knownProjects: [
        {
          trailId: 'trl_future_safe',
          path: project,
          lastSeenAt: '2026-09-10T00:00:00.000Z',
        },
      ],
      projectCatalog: futureCatalog as never,
    });
    const before = readFileSync(globalConfigPath());

    const entry = buildProjectCatalog({ cwd: caller }).projects.find(
      (candidate) => candidate.trailId === 'trl_future_safe',
    );
    expect(entry).toMatchObject({ displayName: 'Future Safe', editBacked: false });
    expect(entry?.aliases).not.toContain('Poison Future Alias');
    expect(resolveProjectSelector(project, { cwd: caller }).state).toBe('selected');
    expect(readFileSync(globalConfigPath())).toEqual(before);
    expect(readGlobalConfig().projectCatalog as unknown).toEqual(futureCatalog);
  });

  test('treats a filesystem alias as one live root rather than a copied trail', () => {
    const base = temp();
    const real = join(base, 'real-project');
    const alias = join(base, 'project-alias');
    mkdirSync(real, { recursive: true });
    trail(real, 'trl_real', 'Real Project', true);
    symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    noteKnownProject(real, 'trl_real');
    noteKnownProject(alias, 'trl_real');

    const catalog = buildProjectCatalog({ cwd: alias });
    const project = catalog.projects.find((item) => item.trailId === 'trl_real');

    expect(readGlobalConfig().knownProjects).toEqual([
      expect.objectContaining({ trailId: 'trl_real', path: real }),
    ]);
    expect(project).toMatchObject({
      root: real,
      liveRoots: [real],
      conflict: false,
    });
  });

  test('selects an uncataloged copied path, then persists the conflict on refresh', () => {
    const caller = temp();
    const first = temp();
    const second = temp();
    trail(first, 'trl_copy', 'Copied Project', true);
    trail(second, 'trl_copy', 'Copied Project', true);
    noteKnownProject(first, 'trl_copy');
    const before = readFileSync(globalConfigPath());

    const explicit = resolveProjectSelector(second, { cwd: caller });
    expect(explicit).toMatchObject({
      state: 'selected',
      selection: {
        trailId: 'trl_copy',
        root: second,
        mode: 'authoritative',
      },
    });
    expect(explicit.selection?.evidence).toContain('duplicate-trail-explicit-path');
    expect(readFileSync(globalConfigPath())).toEqual(before);

    expect(refreshProjectIdentity(second, { expectedTrailId: 'trl_copy' })).toMatchObject(
      {
        trailId: 'trl_copy',
        conflict: true,
      },
    );
    expect(readGlobalConfig().projectCatalog?.byTrailId.trl_copy?.conflictPaths).toEqual(
      expect.arrayContaining([first, second]),
    );
    expect(resolveProjectSelector('trl_copy', { cwd: caller }).state).toBe('conflict');
    expect(resolveProjectSelector('Copied Project', { cwd: caller }).state).toBe(
      'conflict',
    );
  });

  test('fails a pinned command when the selected config identity changes', () => {
    const caller = temp();
    const project = temp();
    trail(project, 'trl_before', 'Pinned Project', true);
    noteKnownProject(project, 'trl_before');
    const resolution = resolveProjectSelector(project, { cwd: caller });
    if (!resolution.selection) throw new Error('Expected an exact-path selection');
    const pin = pinProjectCommandIdentity(project, resolution.selection);

    trail(project, 'trl_after', 'Replacement Project', true);

    let failure: unknown;
    try {
      assertProjectCommandIdentity(pin);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      errorCode: 'PROJECT_IDENTITY_CHANGED',
      nextAction: 'resolve-project-again',
    });
  });

  test('reports the resolved selection separately from a mismatched command root', () => {
    const caller = temp();
    const selected = temp();
    const actual = temp();
    trail(selected, 'trl_selected', 'Selected Project', true);
    trail(actual, 'trl_actual', 'Actual Project', true);
    noteKnownProject(selected, 'trl_selected');
    const resolution = resolveProjectSelector(selected, { cwd: caller });
    if (!resolution.selection) throw new Error('Expected an exact-path selection');

    let failure: unknown;
    try {
      pinProjectCommandIdentity(actual, resolution.selection);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      errorCode: 'PROJECT_IDENTITY_CHANGED',
      details: {
        selectedRoot: selected,
        actualRoot: actual,
      },
    });
  });

  test('fails a pinned command when a selected filesystem alias is retargeted', () => {
    const base = temp();
    const first = join(base, 'first');
    const second = join(base, 'second');
    const alias = join(base, 'selected-project');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    trail(first, 'trl_shared', 'First Project', true);
    trail(second, 'trl_shared', 'Second Project', true);
    noteKnownProject(first, 'trl_shared');
    noteKnownProject(second, 'trl_shared');
    symlinkSync(first, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const resolution = resolveProjectSelector(alias, { cwd: base });
    if (!resolution.selection) throw new Error('Expected an alias-path selection');
    const pin = pinProjectCommandIdentity(alias, resolution.selection);

    rmSync(alias, { recursive: true, force: true });
    symlinkSync(second, alias, process.platform === 'win32' ? 'junction' : 'dir');

    let failure: unknown;
    try {
      assertProjectCommandIdentity(pin);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ errorCode: 'PROJECT_IDENTITY_CHANGED' });
  });

  test('retains move history and bypasses the debounce for identity changes', () => {
    const first = temp();
    const second = temp();
    noteKnownProject(first, 'trl_move');
    noteKnownProject(second, 'trl_move', { editBacked: true });

    expect(readGlobalConfig().knownProjects).toEqual([
      expect.objectContaining({
        trailId: 'trl_move',
        path: second,
        previousPaths: [first],
        editBacked: true,
      }),
    ]);
  });

  test('does not carry provenance across a trail-id change at the same path', () => {
    const project = temp();
    noteKnownProject(project, 'trl_old', { editBacked: true });
    noteKnownProject(project, 'trl_new');

    expect(readGlobalConfig().knownProjects).toEqual([
      expect.objectContaining({ trailId: 'trl_new', path: project }),
    ]);
    expect(readGlobalConfig().knownProjects?.[0]).not.toHaveProperty('editBacked');
  });
});
