import { type ApiClientConstructor, type ApiData } from "./core";
import type { Audiobook } from "@/features/audiobook/types";

/** Add audiobook-domain operations to an API client base class. */
export function WithAudiobooks<TBase extends ApiClientConstructor>(
    Base: TBase,
) {
    abstract class AudiobooksApi extends Base {
        // Audiobooks
        async getAudiobooks() {
            return this.request<ApiData[]>("/audiobooks");
        }

        async getAudiobook(id: string) {
            return this.request<Audiobook>(`/audiobooks/${id}`);
        }

        async getAudiobookSeries(seriesName: string) {
            return this.request<ApiData[]>(
                `/audiobooks/series/${encodeURIComponent(seriesName)}`,
            );
        }

        getAudiobookStreamUrl(id: string): string {
            const baseUrl =
                typeof window === "undefined" ? this.getBaseUrl() : "";
            return `${baseUrl}/api/audiobooks/${encodeURIComponent(id)}/stream`;
        }

        async updateAudiobookProgress(
            id: string,
            currentTime: number,
            duration: number,
            isFinished: boolean = false,
        ) {
            return this.request<ApiData>(`/audiobooks/${id}/progress`, {
                method: "POST",
                body: JSON.stringify({ currentTime, duration, isFinished }),
            });
        }

        async deleteAudiobookProgress(id: string) {
            return this.request<ApiData>(`/audiobooks/${id}/progress`, {
                method: "DELETE",
            });
        }

        async getContinueListening() {
            return this.request<ApiData[]>("/audiobooks/continue-listening");
        }

        async searchAudiobooks(query: string) {
            return this.request<ApiData[]>(
                `/audiobooks/search?q=${encodeURIComponent(query)}`,
            );
        }
    }
    return AudiobooksApi;
}
