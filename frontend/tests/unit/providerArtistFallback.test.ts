import assert from "node:assert/strict";
import test from "node:test";
import { resolveProviderArtistChannel } from "../../features/artist/providerArtistFallback";
import type { DiscoverResult } from "../../features/search/types";

test("provider artist fallback accepts only an exact named YouTube Music artist", () => {
    const results = [
        {
            type: "music",
            name: "Linkin Park Tribute",
            youtubeChannelId: "UCtribute",
        },
        {
            type: "music",
            name: "Linkin Park",
            youtubeChannelId: "UClinkinpark",
        },
        {
            type: "track",
            name: "Linkin Park",
            youtubeChannelId: "UCtrack",
        },
    ] satisfies Array<Partial<DiscoverResult>>;

    assert.equal(
        resolveProviderArtistChannel(results, "  LINKIN PARK  "),
        "UClinkinpark",
    );
    assert.equal(resolveProviderArtistChannel(results, "Linkin"), null);
});

test("provider artist fallback ignores provider results without a channel", () => {
    assert.equal(
        resolveProviderArtistChannel(
            [{ type: "music", name: "Rammstein" }],
            "Rammstein",
        ),
        null,
    );
});

test("provider artist fallback accepts a provider qualifier after an exact local name", () => {
    const results = [
        {
            type: "music",
            name: "2CELLOS (SULIC & HAUSER)",
            youtubeChannelId: "UCxwLkfMCfx2uSKO9w4iRfDQ",
        },
        {
            type: "music",
            name: "2CELLOS Tribute",
            youtubeChannelId: "UCtribute",
        },
    ] satisfies Array<Partial<DiscoverResult>>;

    assert.equal(
        resolveProviderArtistChannel(results, "2CELLOS"),
        "UCxwLkfMCfx2uSKO9w4iRfDQ",
    );
});
