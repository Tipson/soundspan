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
    const {
        waveMode,
        waveMood,
        waveLanguage,
        setWaveMode,
        setWaveMood,
        setWaveLanguage,
    } = useAudioState();
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
                setWaveLanguage(selection.language);
            });
            return;
        }
        persistWaveSelection(ownerId, waveMode, waveMood, waveLanguage);
    }, [
        ownerId,
        setWaveMode,
        setWaveMood,
        setWaveLanguage,
        waveMode,
        waveMood,
        waveLanguage,
    ]);

    return null;
}
