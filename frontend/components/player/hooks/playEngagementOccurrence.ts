/** A captured render describes media selection; neither a queue index nor a load attempt is a solo run. */
export interface PlayEngagementOccurrenceContext {
    recordingKey: string | null;
    rowKey: string | null;
    localOccurrence: number;
    currentIndex: number;
    collaborative: boolean;
}
type Selection = Readonly<{ key: string | null; journal: boolean }>;

/** Call from effects/events only. Its local sequence is not a server idempotency key or playback authority. */
export function createPlayEngagementOccurrenceResolver() {
    let sequence = 0;
    let active: {
        context: PlayEngagementOccurrenceContext;
        selection: Selection;
    } | null = null;
    return {
        observe(context: PlayEngagementOccurrenceContext): Selection {
            if (
                !context.recordingKey ||
                !context.rowKey ||
                !Number.isSafeInteger(context.localOccurrence) ||
                context.localOccurrence < 0
            ) {
                active = null;
                return Object.freeze({ key: null, journal: false });
            }
            const previous = active?.context;
            const membershipChanged =
                previous && previous.collaborative !== context.collaborative;
            const preserves =
                previous &&
                previous.recordingKey === context.recordingKey &&
                previous.localOccurrence === context.localOccurrence &&
                (membershipChanged ||
                    (previous.rowKey === context.rowKey &&
                        (!context.collaborative ||
                            previous.currentIndex === context.currentIndex)));
            if (active && preserves) {
                active.context = { ...context };
                return active.selection;
            }
            const selection = Object.freeze({
                key: `play-occurrence:${++sequence}`,
                journal: !context.collaborative,
            });
            active = { context: { ...context }, selection };
            return selection;
        },
        /** A natural completion/error ends this run; repeat must select its cohort independently. */
        finish(): void {
            active = null;
        },
        /** Cohort choice belongs to the current logical run, not the latest membership flag. */
        current(): Selection {
            return active?.selection ?? { key: null, journal: false };
        },
    };
}
