import type { PlaybackClientMetricInput } from "../api";
import type { ApiClientConstructor } from "./core";
import {
    trackAudioStreamUrl,
    type TrackAudioTarget,
} from "../audio/trackAudioVersions";

/** Staged and published immutable audio IDs visible to an administrator. */
export interface TrackAudioVersions {
    draftId: string | null;
    publishedId: string | null;
}

function trackAudioEndpoint(target: TrackAudioTarget): string {
    return `/track-audio/${target.source}/${encodeURIComponent(target.trackId)}`;
}

const YOUTUBE_LETTERBOX_THUMBNAIL =
    /^(https?:\/\/(?:i\.ytimg\.com|img\.youtube\.com)\/vi\/[^/?#]+\/)hqdefault(\.jpg(?:[?#].*)?)$/i;

function preferWideYouTubeThumbnail(coverId: string): string {
    return coverId.replace(YOUTUBE_LETTERBOX_THUMBNAIL, "$1mqdefault$2");
}

/** Add media-domain operations to an API client base class. */
export function WithMedia<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class MediaApi extends Base {
        /** Read the optional default audio version within the startup budget. */
        async getPublishedTrackAudioUrl(
            target: TrackAudioTarget,
            signal: AbortSignal,
        ): Promise<string | null> {
            const { publishedId } = await this.request<{
                publishedId: unknown;
            }>(trackAudioEndpoint(target), {
                signal,
                timeoutMs: 800,
                retryOnTimeout: false,
                silent404: true,
            });
            return trackAudioStreamUrl(publishedId);
        }

        /** Read draft and published audio for the administrator dialog. */
        getTrackAudioVersions(target: TrackAudioTarget, signal?: AbortSignal) {
            return this.request<TrackAudioVersions>(
                `${trackAudioEndpoint(target)}/manage`,
                { signal },
            );
        }

        /** Stage one MP3 for listening before publication. */
        uploadTrackAudio(
            target: TrackAudioTarget,
            file: File,
            signal?: AbortSignal,
        ) {
            return this.request<TrackAudioVersions>(
                `${trackAudioEndpoint(target)}/draft`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "audio/mpeg" },
                    body: file,
                    signal,
                    timeoutMs: 95_000,
                    retryOnTimeout: false,
                },
            );
        }

        /** Publish the specific version which the administrator previewed. */
        publishTrackAudio(
            target: TrackAudioTarget,
            versionId: string,
            signal?: AbortSignal,
        ) {
            return this.request<TrackAudioVersions>(
                `${trackAudioEndpoint(target)}/publish`,
                {
                    method: "POST",
                    body: JSON.stringify({ versionId }),
                    signal,
                    retryOnTimeout: false,
                },
            );
        }

        /** Withdraw the specified currently published version. */
        withdrawTrackAudio(
            target: TrackAudioTarget,
            versionId: string,
            signal?: AbortSignal,
        ) {
            return this.request<TrackAudioVersions>(
                `${trackAudioEndpoint(target)}/published/${encodeURIComponent(versionId)}`,
                { method: "DELETE", signal, retryOnTimeout: false },
            );
        }

        /** Read a revocable device-file URL without attaching server credentials. */
        async readLocalDeviceFile(
            url: string,
            signal: AbortSignal,
        ): Promise<Response> {
            signal.throwIfAborted();
            if (!url.startsWith("blob:"))
                throw new Error("Expected local device file");
            return fetch(url, { signal });
        }

        // Streaming
        getStreamUrl(trackId: string, quality?: string): string {
            const baseUrl =
                typeof window === "undefined" ? this.getBaseUrl() : "";
            const params = new URLSearchParams();
            if (quality) params.set("quality", quality);
            const query = params.toString();
            return `${baseUrl}/api/library/tracks/${encodeURIComponent(trackId)}/stream${query ? `?${query}` : ""}`;
        }

        async reportPlaybackClientMetric(
            input: PlaybackClientMetricInput,
            signal?: AbortSignal,
        ): Promise<void> {
            await this.request<void>("/streaming/v1/client-metrics", {
                method: "POST",
                body: JSON.stringify(input),
                signal,
                timeoutMs: 5000,
                retryOnTimeout: false,
            });
        }

        /**
         * Get the URL for cover art.
         * @param coverId - The cover ID, URL, or path
         * @param size - Optional size in pixels
         * @param _includeToken - Retained for call-site compatibility; image auth is cookie-backed
         */
        getCoverArtUrl(
            coverId: string,
            size?: number,
            _includeToken = true,
        ): string {
            // Image credentials travel via the same-origin /api proxy cookie,
            // never in a URL that can leak through history or access logs.
            const baseUrl =
                typeof window === "undefined" ? this.getBaseUrl() : "";

            // Check if this is an audiobook cover path (served by audiobooks endpoint, not proxied)
            if (coverId && coverId.startsWith("/audiobooks/")) {
                return `${baseUrl}/api${coverId}`;
            }

            // Check if this is a podcast cover path (served by podcasts endpoint, not proxied)
            if (coverId && coverId.startsWith("/podcasts/")) {
                return `${baseUrl}/api${coverId}`;
            }

            // Check if coverId is an external URL (needs to be proxied)
            // Also handle native: paths which need URL encoding
            if (
                coverId &&
                (coverId.startsWith("http://") ||
                    coverId.startsWith("https://") ||
                    coverId.startsWith("native:"))
            ) {
                // Pass as query parameter to avoid URL encoding issues
                const params = new URLSearchParams({
                    url: preferWideYouTubeThumbnail(coverId),
                });
                if (size) params.append("size", size.toString());
                return `${baseUrl}/api/library/cover-art?${params.toString()}`;
            }

            // Otherwise use as path parameter (cover ID - typically a hash)
            const params = new URLSearchParams();
            if (size) params.append("size", size.toString());
            const queryString = params.toString();
            return `${baseUrl}/api/library/cover-art/${encodeURIComponent(coverId)}${
                queryString ? "?" + queryString : ""
            }`;
        }

        /**
         * Get the proxied URL for a YouTube Music browse thumbnail.
         * @param externalUrl - The original external thumbnail URL
         */
        getBrowseImageUrl(externalUrl: string): string {
            const baseUrl =
                typeof window === "undefined" ? this.getBaseUrl() : "";
            const params = new URLSearchParams({ url: externalUrl });
            return `${baseUrl}/api/browse/ytmusic/image?${params.toString()}`;
        }

        async getTrackPreview(artistName: string, trackTitle: string) {
            return this.request<{ videoId: string }>(
                `/artists/preview/${encodeURIComponent(
                    artistName,
                )}/${encodeURIComponent(trackTitle)}`,
            );
        }

        getPreviewStreamUrl(videoId: string): string {
            const baseUrl =
                typeof window === "undefined" ? this.getBaseUrl() : "";
            return `${baseUrl}/api/artists/preview-stream/${encodeURIComponent(videoId)}`;
        }

        async getFreshPreviewUrl(playlistId: string, pendingTrackId: string) {
            return this.request<{ previewUrl: string }>(
                `/playlists/${playlistId}/pending/${pendingTrackId}/preview`,
            );
        }
    }
    return MediaApi;
}
