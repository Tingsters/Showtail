import type { ConversationEvent, Event, ReportData, Turn } from '../../types.ts';

/** The original local identities of events sharing one native semantic event. */
export interface ProjectionDuplicate {
  sessionId: string;
  actorSlug: string;
  tool: string;
  nativeId: string;
  part: `display:${Event['type']}` | `structured:${ConversationEvent['type']}`;
  canonicalId?: string;
  aliasId?: string;
  canonicalSequence?: number;
  aliasSequence?: number;
}

export interface ReportProjection {
  /** A display view. The supplied report and its captured records are unchanged. */
  data: ReportData;
  /** Removed local display record ID -> retained record ID, for existing links. */
  aliases: Record<string, string>;
  duplicates: ProjectionDuplicate[];
}

/** JSON object order is not semantic; array order and every defined value are. */
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, ordered(item)]),
    );
  return value;
}

/**
 * Collapse duplicate report projections, never repeated text or revisions.
 *
 * A native ID is scoped to its session, actor, tool and semantic part. Matching
 * identities merge only when their payloads also agree. Local row IDs, turn
 * links and structured sequence positions describe capture/projection rather
 * than content; aliases retain those identities separately. Conflicting native
 * payloads remain visible. We also retain copies linked to different turns:
 * removing them would otherwise change an established prompt association.
 */
export function projectReport(data: ReportData): ReportProjection {
  const aliases: Record<string, string> = Object.create(null);
  const duplicates: ProjectionDuplicate[] = [];

  function projectTurn<T extends Omit<Turn, 'prompt'>>(turn: T): T {
    function unique<E extends Event | ConversationEvent>(
      events: E[],
      stream: 'display' | 'structured',
    ): E[] {
      const seen = new Map<string, Map<string, E>>();
      return events.filter((event) => {
        if (!event.sourceId?.trim()) return true;
        const part = `${stream}:${event.type}` as ProjectionDuplicate['part'];
        const key = JSON.stringify([
          turn.sessionId,
          turn.actorSlug,
          turn.tool,
          part,
          event.sourceId,
        ]);
        const semantic = Object.fromEntries(
          Object.entries(event).filter(
            ([key]) =>
              (stream !== 'display' || (key !== 'id' && key !== 'turnId')) &&
              (stream !== 'structured' || key !== 'sequence'),
          ),
        );
        const signature = JSON.stringify(ordered(semantic));
        const variants = seen.get(key) ?? new Map<string, E>();
        const canonical = variants.get(signature);
        if (!canonical) {
          variants.set(signature, event);
          seen.set(key, variants);
          return true;
        }
        const duplicate: ProjectionDuplicate = {
          sessionId: turn.sessionId,
          actorSlug: turn.actorSlug,
          tool: turn.tool,
          nativeId: event.sourceId,
          part,
        };
        if (stream === 'display') {
          const kept = canonical as Event;
          const removed = event as Event;
          duplicate.canonicalId = kept.id;
          duplicate.aliasId = removed.id;
          if (removed.id !== kept.id) aliases[removed.id] = kept.id;
        } else {
          duplicate.canonicalSequence = (canonical as ConversationEvent).sequence;
          duplicate.aliasSequence = (event as ConversationEvent).sequence;
        }
        duplicates.push(duplicate);
        return false;
      });
    }

    return {
      ...turn,
      aiOutputs: unique(turn.aiOutputs, 'display'),
      toolCalls: unique(turn.toolCalls, 'display'),
      decisions: unique(turn.decisions, 'display'),
      plans: unique(turn.plans, 'display'),
      events: unique(turn.events, 'structured'),
    };
  }

  return {
    data: {
      ...data,
      turns: data.turns.map(projectTurn),
      ...(data.unattributedWork
        ? { unattributedWork: data.unattributedWork.map(projectTurn) }
        : {}),
    },
    aliases,
    duplicates,
  };
}
