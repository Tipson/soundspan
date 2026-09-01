import { config } from "../../config";
import { getActiveSpace } from "../embeddingSpaces";
import {
    assertProviderMatchesActiveSpace,
    embedText,
    fetchProviderSpace,
    type EmbeddingVectorSpace,
} from "../vibeProvider";
import type { RecommendationMood } from "./types";

const CACHE_TTL_MS = 60_000;
const FAILURE_COOLDOWN_MS = 5 * 60 * 1_000;
const MOOD_DEADLINE_MS = 750;

const MOOD_PROMPTS = {
    calm: "calm relaxed peaceful low energy music",
    energetic: "energetic upbeat high intensity music",
    focus: "focus concentration unobtrusive steady music",
    workout: "workout training driving rhythmic energetic music",
} as const;

type SemanticMood = keyof typeof MOOD_PROMPTS;

export interface RecommendationMoodEmbeddingResult {
    embedding: number[] | null;
    degraded: boolean;
}

interface MoodEmbeddingDependencies {
    enabled: boolean;
    loadSpace: () => Promise<EmbeddingVectorSpace>;
    embedText: (text: string, space: EmbeddingVectorSpace) => Promise<number[]>;
    now: () => Date;
    timeoutMs: number;
}

interface CachedMoodEmbedding {
    embedding: number[];
    expiresAt: number;
}

function semanticMood(mood: RecommendationMood | null): SemanticMood | null {
    return mood && mood in MOOD_PROMPTS ? (mood as SemanticMood) : null;
}

async function beforeDeadline<T>(
    operation: Promise<T>,
    deadline: number,
): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Mood embedding deadline exceeded");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error("Mood embedding deadline exceeded")),
                    remaining,
                );
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Bounded, process-cached DCLAP text vectors for acoustic mood intents. */
export class RecommendationMoodEmbeddingStore {
    private readonly cache = new Map<string, CachedMoodEmbedding>();
    private readonly latestCacheKey = new Map<SemanticMood, string>();
    private readonly failures = new Map<SemanticMood, number>();
    private readonly inFlight = new Map<
        SemanticMood,
        Promise<RecommendationMoodEmbeddingResult>
    >();

    constructor(private readonly dependencies: MoodEmbeddingDependencies) {}

    async load(
        mood: RecommendationMood | null,
    ): Promise<RecommendationMoodEmbeddingResult> {
        const selected = semanticMood(mood);
        if (!selected || !this.dependencies.enabled) {
            return { embedding: null, degraded: false };
        }
        const now = this.dependencies.now().getTime();
        const cached = this.cache.get(this.latestCacheKey.get(selected) ?? "");
        if (cached && cached.expiresAt > now) {
            return { embedding: [...cached.embedding], degraded: false };
        }
        if ((this.failures.get(selected) ?? 0) > now) {
            return { embedding: null, degraded: true };
        }
        const active = this.inFlight.get(selected);
        if (active) return active;

        const load = this.loadFresh(selected).finally(() => {
            if (this.inFlight.get(selected) === load) {
                this.inFlight.delete(selected);
            }
        });
        this.inFlight.set(selected, load);
        return load;
    }

    private async loadFresh(
        mood: SemanticMood,
    ): Promise<RecommendationMoodEmbeddingResult> {
        const deadline = Date.now() + this.dependencies.timeoutMs;
        try {
            const space = await beforeDeadline(
                this.dependencies.loadSpace(),
                deadline,
            );
            const cacheKey = `${space.id}:${mood}`;
            const now = this.dependencies.now().getTime();
            const cached = this.cache.get(cacheKey);
            if (cached && cached.expiresAt > now) {
                return { embedding: [...cached.embedding], degraded: false };
            }
            const embedding = await beforeDeadline(
                this.dependencies.embedText(MOOD_PROMPTS[mood], space),
                deadline,
            );
            if (
                embedding.length !== space.dim ||
                embedding.some((value) => !Number.isFinite(value))
            ) {
                throw new TypeError("Mood embedding has an invalid vector");
            }
            this.cache.set(cacheKey, {
                embedding: [...embedding],
                expiresAt: now + CACHE_TTL_MS,
            });
            this.latestCacheKey.set(mood, cacheKey);
            this.failures.delete(mood);
            return { embedding: [...embedding], degraded: false };
        } catch {
            this.failures.set(
                mood,
                this.dependencies.now().getTime() + FAILURE_COOLDOWN_MS,
            );
            return { embedding: null, degraded: true };
        }
    }
}

async function loadCompatibleSpace(): Promise<EmbeddingVectorSpace> {
    const [activeSpace, providerSpace] = await Promise.all([
        getActiveSpace(),
        fetchProviderSpace(),
    ]);
    assertProviderMatchesActiveSpace(providerSpace, activeSpace);
    return { id: activeSpace.id, dim: activeSpace.dim };
}

export const recommendationMoodEmbeddingStore =
    new RecommendationMoodEmbeddingStore({
        enabled:
            config.features.audioAnalysis && Boolean(config.vibeProviderUrl),
        loadSpace: loadCompatibleSpace,
        embedText,
        now: () => new Date(),
        timeoutMs: MOOD_DEADLINE_MS,
    });
