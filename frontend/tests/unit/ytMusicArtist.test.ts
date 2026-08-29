import assert from "node:assert/strict";
import test from "node:test";
import {
    normalizeYtMusicArtist,
    parseYtMusicDuration,
} from "../../features/artist/ytMusicArtist";
import { getDiscoveryArtistHref } from "../../utils/artistRoute";
import { api } from "../../lib/api";

test("provider artist href keeps a real MBID when one is available", () => {
    assert.equal(
        getDiscoveryArtistHref({
            name: "Massive Attack",
            mbid: "10adbe5c-6a8c-4d1f-b0a6-2972906e9944",
            youtubeChannelId: "UCmassiveattack",
        }),
        "/artist/10adbe5c-6a8c-4d1f-b0a6-2972906e9944",
    );
});

test("provider artist href carries both display name and exact YouTube identity", () => {
    assert.equal(
        getDiscoveryArtistHref({
            name: "AC/DC & Friends",
            youtubeChannelId: "UC_ac-dc",
        }),
        "/artist/AC%2FDC%20%26%20Friends?provider=ytmusic&channelId=UC_ac-dc",
    );
});

test("YouTube Music artist API encodes the channel route segment", async () => {
    const client = api as unknown as { request: unknown };
    const originalRequest = client.request;
    let requestedEndpoint = "";
    client.request = async (endpoint: string) => {
        requestedEndpoint = endpoint;
        return {};
    };
    try {
        await api.getYtMusicArtist("UC/channel id");
    } finally {
        client.request = originalRequest;
    }

    assert.equal(requestedEndpoint, "/ytmusic/artist/UC%2Fchannel%20id");
});

test("duration parser accepts YouTube Music clock strings", () => {
    assert.equal(parseYtMusicDuration("4:35"), 275);
    assert.equal(parseYtMusicDuration("1:02:03"), 3723);
    assert.equal(parseYtMusicDuration("invalid"), 0);
});

test("YouTube Music artist payload becomes playable tracks and browsable albums", () => {
    const result = normalizeYtMusicArtist(
        {
            channelId: "UCmassiveattack",
            name: "Massive Attack",
            description: "Trip-hop pioneers",
            thumbnails: [
                { url: "https://img/small.jpg", width: 120 },
                { url: "https://img/large.jpg", width: 720 },
            ],
            songs: [
                {
                    videoId: "vid-teardrop",
                    title: "Teardrop",
                    artist: "Massive Attack",
                    album: "Mezzanine",
                    duration: "5:31",
                },
                { videoId: null, title: "Unplayable" },
            ],
            albums: [
                {
                    browseId: "MPREb_mezzanine",
                    title: "Mezzanine",
                    year: "1998",
                    thumbnails: [{ url: "https://img/album.jpg", width: 544 }],
                },
                { browseId: null, title: "Broken album" },
            ],
        },
        { channelId: "UCmassiveattack", fallbackName: "Fallback" },
    );

    assert.equal(result.artist.id, "ytartist:UCmassiveattack");
    assert.equal(result.artist.name, "Massive Attack");
    assert.equal(result.artist.image, "https://img/large.jpg");
    assert.equal(result.artist.bio, "Trip-hop pioneers");
    assert.deepEqual(result.artist.topTracks, [
        {
            id: "yt:vid-teardrop",
            title: "Teardrop",
            duration: 331,
            artist: {
                id: "ytartist:UCmassiveattack",
                name: "Massive Attack",
            },
            album: {
                title: "Mezzanine",
                coverArt: "https://img/large.jpg",
            },
            streamSource: "youtube",
            youtubeVideoId: "vid-teardrop",
            source: "youtube",
        },
    ]);
    assert.deepEqual(result.providerAlbums, [
        {
            type: "album",
            id: "MPREb_mezzanine",
            browseId: "MPREb_mezzanine",
            name: "Mezzanine",
            artist: "Massive Attack",
            image: "https://img/album.jpg",
            year: "1998",
            provider: "ytmusic",
        },
    ]);
});
