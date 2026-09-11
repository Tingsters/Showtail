import { isAbsolute } from 'node:path';
import { extractPrompt, extractSessionId, type HookPayload } from './hookInput.ts';
import type { HookTranscript, NormalizedHookEvent } from '../plugins/types.ts';

export const VSCODE_EXTENSION_HOOK_PROTOCOL = 'showtail-vscode-extension-hook/v1';

interface VsCodeExtensionAssistant {
  text: string;
  sourceId: string;
  model?: string;
}

export interface VsCodeExtensionHookPayload extends HookPayload {
  showtailExtension?: unknown;
  projectCwd?: unknown;
  workspacePaths?: unknown;
  timestamp?: unknown;
  editedFiles?: unknown;
  assistant?: unknown;
}

function isAbsolutePathList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every(
      (path) =>
        typeof path === 'string' &&
        path.length > 0 &&
        path.length <= 32_768 &&
        isAbsolute(path),
    )
  );
}

function extensionAssistant(value: unknown): VsCodeExtensionAssistant | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const assistant = value as Record<string, unknown>;
  if (
    typeof assistant.text !== 'string' ||
    assistant.text.trim().length === 0 ||
    typeof assistant.sourceId !== 'string' ||
    assistant.sourceId.trim().length === 0 ||
    (assistant.model !== undefined && typeof assistant.model !== 'string')
  ) {
    return null;
  }
  return {
    text: assistant.text,
    sourceId: assistant.sourceId,
    ...(typeof assistant.model === 'string' && assistant.model.length > 0
      ? { model: assistant.model }
      : {}),
  };
}

/** Accept only the versioned payload emitted by Showtail's own VS Code extension. */
export function isVsCodeExtensionPayload(
  raw: unknown,
): raw is VsCodeExtensionHookPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const payload = raw as VsCodeExtensionHookPayload;
  if (payload.showtailExtension !== VSCODE_EXTENSION_HOOK_PROTOCOL) return false;
  if (
    typeof payload.session_id !== 'string' ||
    payload.session_id.trim().length === 0 ||
    payload.session_id.length > 512 ||
    typeof payload.cwd !== 'string' ||
    !isAbsolute(payload.cwd) ||
    typeof payload.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(payload.timestamp)) ||
    !(
      payload.projectCwd === null ||
      (typeof payload.projectCwd === 'string' && isAbsolute(payload.projectCwd))
    ) ||
    !isAbsolutePathList(payload.workspacePaths)
  ) {
    return false;
  }
  if (payload.prompt !== undefined && typeof payload.prompt !== 'string') return false;
  if (payload.editedFiles !== undefined && !isAbsolutePathList(payload.editedFiles)) {
    return false;
  }
  if (payload.assistant !== undefined && extensionAssistant(payload.assistant) === null) {
    return false;
  }
  return true;
}

export function parseVsCodeExtensionPayload(raw: unknown): NormalizedHookEvent {
  const payload = raw as VsCodeExtensionHookPayload;
  return {
    nativeSessionId: extractSessionId(payload),
    projectCwd:
      payload.projectCwd === null || typeof payload.projectCwd === 'string'
        ? payload.projectCwd
        : undefined,
    prompt: extractPrompt(payload) ?? undefined,
    editedFiles: isAbsolutePathList(payload.editedFiles) ? payload.editedFiles : [],
    workspacePaths: isAbsolutePathList(payload.workspacePaths)
      ? payload.workspacePaths
      : [],
  };
}

export function vscodeExtensionTranscript(raw: unknown): HookTranscript | null {
  const payload = raw as VsCodeExtensionHookPayload;
  const assistant = extensionAssistant(payload.assistant);
  if (!assistant) return null;
  return {
    sessionId: extractSessionId(payload),
    messages: [
      {
        role: 'assistant',
        text: assistant.text,
        sourceId: assistant.sourceId,
        model: assistant.model,
        timestamp: payload.timestamp as string,
      },
    ],
  };
}
