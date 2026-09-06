"use client";

import { useEffect, useRef } from "react";
import { useAudioState } from "@/lib/audio-state-context";
import { useAuth } from "@/lib/auth-context";
import {
    persistWaveSelection,
    readPersistedWaveSelection,
} from "@/lib/waveSelection";

/** Keeps the account-scoped Wave direction shared by Home and /vibe. */
export function WaveSelectionSynchronizer() {
    const { user } = useAuth();
    const ownerId = user?.id ?? null;
    const { waveMode, waveMood, setWaveMode, setWaveMood } = useAudioState();
    const hydratedOwnerIdRef = useRef<string | null>(null);

    useEffect(() => {
        if (!ownerId) {
            hydratedOwnerIdRef.current = null;
            return;
        }
        if (hydratedOwnerIdRef.current !== ownerId) {
            hydratedOwnerIdRef.current = ownerId;
            const selection = readPersistedWaveSelection(ownerId);
            queueMicrotask(() => {
                if (hydratedOwnerIdRef.current !== ownerId) return;
                setWaveMode(selection.mode);
                setWaveMood(selection.mood);
            });
            return;
        }
        persistWaveSelection(ownerId, waveMode, waveMood);
    }, [ownerId, setWaveMode, setWaveMood, waveMode, waveMood]);

    return null;
}
