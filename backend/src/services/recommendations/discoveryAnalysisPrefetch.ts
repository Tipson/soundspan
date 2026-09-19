import type { RecommendationCandidate } from "./types";

export interface DiscoveryAnalysisPrefetchDependencies {
    loadUsers(): Promise<string[]>;
    canContinue(): Promise<boolean>;
    /** Persist the account turn before provider I/O; false means ownership was lost. */
    visit(userId: string): Promise<boolean>;
    loadCandidates(
        userId: string,
    ): Promise<{ candidates: RecommendationCandidate[]; nextCursor: number }>;
    admit(userId: string, candidates: RecommendationCandidate[]): Promise<void>;
    advance(userId: string, nextCursor: number): Promise<void>;
    failed(userId: string, error: unknown): void;
}

/** Small serial preparation pass; persistent cursors and admission guards belong to the adapter. */
export class DiscoveryAnalysisPrefetch {
    constructor(
        private readonly dependencies: DiscoveryAnalysisPrefetchDependencies,
    ) {}

    async run(signal: AbortSignal): Promise<number> {
        if (signal.aborted) return 0;
        const users = [...new Set(await this.dependencies.loadUsers())].slice(
            0,
            4,
        );
        let prepared = 0;
        for (const userId of users) {
            if (signal.aborted || !(await this.dependencies.canContinue()))
                break;
            try {
                if (!(await this.dependencies.visit(userId)) || signal.aborted)
                    break;
                const batch = await this.dependencies.loadCandidates(userId);
                if (signal.aborted || !(await this.dependencies.canContinue()))
                    break;
                await this.dependencies.admit(
                    userId,
                    batch.candidates.slice(0, 12),
                );
                if (signal.aborted) break;
                await this.dependencies.advance(userId, batch.nextCursor);
                prepared++;
            } catch (error) {
                if (!signal.aborted) this.dependencies.failed(userId, error);
            }
        }
        return prepared;
    }
}
