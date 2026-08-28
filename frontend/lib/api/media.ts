import type { PlaybackClientMetricInput } from "../api";
import type { ApiClientConstructor } from "./core";

/** Add media-domain operations to an API client base class. */
export function WithMedia<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class MediaApi extends Base {
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
        ): Promise<void> {
            await this.request<void>("/streaming/v1/client-metrics", {
                method: "POST",
                body: JSON.stringify(input),
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
                const params = new URLSearchParams({ url: coverId });
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
