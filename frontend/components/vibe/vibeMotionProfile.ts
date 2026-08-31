import type { WaveMode, WaveMood } from "@/lib/audio-state-context";

const MIN_BPM = 48;
const MAX_BPM = 210;
const MIN_ENERGY = 0.12;
const MAX_ENERGY = 1;

const MOOD_BASELINES: Record<Exclude<WaveMood, null>, [number, number]> = {
    calm: [76, 0.28],
    energetic: [136, 0.82],
    focus: [88, 0.42],
    workout: [148, 0.9],
    favorites: [112, 0.68],
    forgotten: [92, 0.4],
};

const MODE_BASELINES: Record<WaveMode, [number, number]> = {
    "for-you": [108, 0.58],
    new: [124, 0.72],
    familiar: [96, 0.46],
};

export interface VibeMotionInput {
    trackId: string | null;
    bpm?: number | null;
    energy?: number | null;
    mode: WaveMode;
    mood: WaveMood;
}

export interface VibeMotionProfile {
    bpm: number;
    energy: number;
    beatIntervalMs: number;
    phaseVelocity: number;
    seedPhase: number;
    tempoSource: "analyzed" | "deterministic-fallback";
    energySource: "analyzed" | "deterministic-fallback";
}

export interface VibeMotionPolicy {
    isDesktop: boolean;
    isPlaying: boolean;
    isVisible: boolean;
    prefersReducedMotion: boolean;
    lowPower: boolean;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function stableHash(value: string): number {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
    }
    return hash >>> 0;
}

function byteUnit(hash: number, shift: number): number {
    return ((hash >>> shift) & 0xff) / 255;
}

/** Resolves tempo-aware motion without sampling or rerouting the audio output. */
export function resolveVibeMotionProfile(
    input: VibeMotionInput,
): VibeMotionProfile {
    const fallback = input.mood
        ? MOOD_BASELINES[input.mood]
        : MODE_BASELINES[input.mode];
    const hash = stableHash(
        `${input.trackId ?? "wave"}:${input.mode}:${input.mood ?? "any"}`,
    );
    const analyzedBpm =
        typeof input.bpm === "number" &&
        Number.isFinite(input.bpm) &&
        input.bpm > 0
            ? input.bpm
            : null;
    const analyzedEnergy =
        typeof input.energy === "number" && Number.isFinite(input.energy)
            ? input.energy
            : null;
    const bpm =
        analyzedBpm !== null
            ? clamp(analyzedBpm, MIN_BPM, MAX_BPM)
            : clamp(fallback[0] + (byteUnit(hash, 0) - 0.5) * 12, 64, 168);
    const energy =
        analyzedEnergy !== null
            ? clamp(analyzedEnergy, MIN_ENERGY, MAX_ENERGY)
            : clamp(fallback[1] + (byteUnit(hash, 8) - 0.5) * 0.12, 0.18, 0.94);

    return {
        bpm,
        energy,
        beatIntervalMs: 60_000 / bpm,
        phaseVelocity: (Math.PI * 2 * bpm) / 60,
        seedPhase: byteUnit(hash, 16) * Math.PI * 2,
        tempoSource:
            analyzedBpm !== null ? "analyzed" : "deterministic-fallback",
        energySource:
            analyzedEnergy !== null ? "analyzed" : "deterministic-fallback",
    };
}

/** Keeps ambient motion out of paused, hidden, reduced-motion and low-power states. */
export function shouldAnimateVibeAmbient(policy: VibeMotionPolicy): boolean {
    return (
        policy.isDesktop &&
        policy.isPlaying &&
        policy.isVisible &&
        !policy.prefersReducedMotion &&
        !policy.lowPower
    );
}
