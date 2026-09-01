import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

interface CapturedQueryOptions {
    queryKey: readonly unknown[];
    queryFn: () => Promise<unknown>;
    enabled?: boolean;
}

const state = {
    queryOptions: [] as CapturedQueryOptions[],
    ytArtistCalls: [] as string[],
    localArtistCalls: [] as string[],
    discoveryArtistCalls: [] as string[],
};

const reactQueryExports = {
    useQuery: (options: CapturedQueryOptions) => {
        state.queryOptions.push(options);
        return {
            data: undefined,
            isLoading: false,
            isFetching: false,
            isError: false,
            refetch: async () => undefined,
        };
    },
};

mock.module("@tanstack/react-query", { namedExports: reactQueryExports });
mock.module(
    new URL(
        "../../node_modules/@tanstack/react-query/build/modern/index.cjs",
        import.meta.url,
    ).href,
    { namedExports: reactQueryExports },
);

mock.module("next/navigation", {
    namedExports: {
        useParams: () => ({ id: "Massive Attack" }),
        useSearchParams: () =>
            new URLSearchParams("provider=ytmusic&channelId=UCmassiveattack"),
    },
});

mock.module("@/hooks/useQueries", {
    namedExports: {
        queryKeys: {
            artist: (id: string) => ["artist", id],
            artistDetails: (id: string, source: string | null) => [
                "artist",
                "details",
                id,
                source,
            ],
            ytMusicArtist: (channelId: string) => [
                "artist",
                "ytmusic",
                channelId,
            ],
        },
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getYtMusicArtist: async (channelId: string) => {
                state.ytArtistCalls.push(channelId);
                return {
                    channelId,
                    name: "Massive Attack",
                    songs: [
                        {
                            videoId: "teardrop",
                            title: "Teardrop",
                            duration: "5:31",
                        },
                    ],
                    albums: [
                        {
                            browseId: "MPREb_mezzanine",
                            title: "Mezzanine",
                        },
                    ],
                };
            },
            getArtist: async (id: string) => {
                state.localArtistCalls.push(id);
                return null;
            },
            getArtistDiscovery: async (id: string) => {
                state.discoveryArtistCalls.push(id);
                return null;
            },
        },
    },
});

mock.module("@/lib/download-context", {
    namedExports: {
        useDownloadContext: () => ({
            downloadStatus: { activeDownloads: [] },
        }),
    },
});

beforeEach(() => {
    state.queryOptions = [];
    state.ytArtistCalls = [];
    state.localArtistCalls = [];
    state.discoveryArtistCalls = [];
});

test("provider artist enables only the YouTube Music query", async () => {
    const { useArtistData } =
        await import("../../features/artist/hooks/useArtistData");
    const Probe = () => {
        useArtistData();
        return null;
    };

    renderToStaticMarkup(React.createElement(Probe));

    const providerQuery = state.queryOptions.find(
        (query) => query.queryKey[1] === "ytmusic",
    );
    const localQuery = state.queryOptions.find(
        (query) => query.queryKey.length === 2,
    );
    const detailQuery = state.queryOptions.find(
        (query) => query.queryKey[1] === "details",
    );
    assert.ok(providerQuery);
    assert.equal(providerQuery.enabled, true);
    assert.equal(localQuery?.enabled, false);
    assert.equal(detailQuery?.enabled, false);

    const normalized = (await providerQuery.queryFn()) as {
        artist: { topTracks?: Array<{ youtubeVideoId?: string }> };
        providerAlbums: Array<{ browseId?: string }>;
    };
    assert.deepEqual(state.ytArtistCalls, ["UCmassiveattack"]);
    assert.deepEqual(state.localArtistCalls, []);
    assert.deepEqual(state.discoveryArtistCalls, []);
    assert.equal(normalized.artist.topTracks?.[0]?.youtubeVideoId, "teardrop");
    assert.equal(normalized.providerAlbums[0]?.browseId, "MPREb_mezzanine");
});
