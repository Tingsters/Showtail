import PROJECT_TARGETING_INSTRUCTIONS from '../../assets/shared/project-targeting.md' with { type: 'text' };

/** Append the shared, host-neutral project-control policy to managed instructions. */
export function withProjectTargetingInstructions(hostInstructions: string): string {
  return `${hostInstructions.trimEnd()}\n\n${PROJECT_TARGETING_INSTRUCTIONS.trim()}\n`;
}

export { PROJECT_TARGETING_INSTRUCTIONS };
