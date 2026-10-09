import type { Request, Response } from "express";
import { discoveryRecommendationsService } from "../../services/discovery";
import { personalWeeklyDiscoveryService } from "../../services/personalWeeklyDiscovery";
import { sendCurrentPlaylistFailure } from "./shared";

/** Handles the recommendation-mode current discovery playlist. */
export async function handleModernCurrent(
    req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        const playlist =
            await discoveryRecommendationsService.getCurrentPlaylist(
                req.user!.id,
            );
        return res.json(
            playlist.tracks.length > 0
                ? playlist
                : await personalWeeklyDiscoveryService.getCurrent(req.user!.id),
        );
    } catch (error) {
        sendCurrentPlaylistFailure(res, error);
    }
}
