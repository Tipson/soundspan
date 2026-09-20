"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/** Fetch small artist portraits with three concurrent requests and reusable cache. */
export function useTasteArtistArtwork(names: readonly string[]) {
    const queryClient = useQueryClient();
    const [portraits, setPortraits] = useState<Record<string, string>>({});
    const namesKey = JSON.stringify(names);
    useEffect(() => {
        const names: string[] = JSON.parse(namesKey);
        const controller = new AbortController();
        const { signal } = controller;
        let cursor = 0;
        const worker = async () => {
            while (cursor < names.length && !signal.aborted) {
                const name = names[cursor++];
                const key = ["taste-artist-portrait", name];
                const cached = queryClient.getQueryData<string>(key);
                if (cached) {
                    setPortraits((current) => ({ ...current, [name]: cached }));
                    continue;
                }
                try {
                    const artist = await api.request<{ image?: string | null }>(
                        `/taste-profile/artist-image?name=${encodeURIComponent(name)}`,
                        { signal, timeoutMs: 8_000, retryOnTimeout: false },
                    );
                    signal.throwIfAborted();
                    if (artist.image) {
                        const image = api.getCoverArtUrl(artist.image, 240);
                        setPortraits((current) => ({
                            ...current,
                            [name]: image,
                        }));
                        queryClient.setQueryData(key, image);
                    }
                } catch {
                    // Missing artwork must never prevent selecting an artist.
                }
            }
        };
        void Promise.all(
            Array.from({ length: Math.min(3, names.length) }, worker),
        );
        return () => controller.abort();
    }, [namesKey, queryClient]);
    return portraits;
}
