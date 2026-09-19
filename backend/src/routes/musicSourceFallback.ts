import type { Request, Response } from "express";
import { prisma } from "../utils/db";
import { musicSourceResolver } from "../services/musicSources/runtime";
import { createMusicSourceFallback } from "../services/musicSources/fallback";

const fallback = createMusicSourceFallback({
    enabled: async () =>
        (await prisma.musicSourceConnection.count({
            where: { enabled: true },
        })) > 0,
    recording: async (videoId) => {
        const track = await prisma.trackYtMusic.findUnique({
            where: { videoId },
            select: { title: true, artist: true, duration: true },
        });
        return track && track.duration > 0
            ? {
                  title: track.title,
                  artists: [track.artist],
                  duration: track.duration,
                  contentVersion: "unknown",
              }
            : null;
    },
    resolve: (userId, recording, signal) =>
        musicSourceResolver.resolve(userId, recording, signal),
});
/** Recover an initial YouTube outage via a same-origin lease without exposing upstream URLs. */
export async function acquireWithMusicSourceFallback<T>(
    req: Request,
    res: Response,
    signal: AbortSignal,
    original: (signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
    // Speculative preloads must never start a second provider search.
    if (req.query.purpose === "preload" || !req.query.playbackSession)
        return original(signal);
    const result = await fallback.acquire({
        userId: req.user!.id,
        videoId: String(req.params.videoId),
        sessionId:
            typeof req.query.playbackSession === "string"
                ? req.query.playbackSession
                : undefined,
        range: req.headers.range,
        signal,
        original,
    });
    if ("redirect" in result) {
        if (!signal.aborted && !res.destroyed)
            res.set("Cache-Control", "private, no-store").redirect(
                307,
                result.redirect,
            );
        return null;
    }
    return result.stream;
}
