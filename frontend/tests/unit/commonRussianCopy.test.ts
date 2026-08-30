import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const surfaceFiles = [
    "app/audiobooks/series/[name]/page.tsx",
    "app/peer-playlists/[peerId]/[remoteId]/page.tsx",
    "app/search/loading.tsx",
    "components/EnrichmentFailuresModal.tsx",
    "components/track/TrackList.tsx",
    "components/track/TrackRow.tsx",
    "components/ui/LibraryBadge.tsx",
    "features/artist/components/PopularTracks.tsx",
    "features/audiobook/components/AudiobookActionBar.tsx",
].map((path) => readFileSync(path, "utf8"));

test("общие музыкальные экраны не возвращают английские UI-команды", () => {
    const source = surfaceFiles.join("\n");
    const forbidden = [
        'aria-label="Loading search results"',
        'title="Your Library"',
        'title="Drag to reorder"',
        'title="Reset progress"',
        'title="Mark as completed"',
        'title="Listen again"',
        'title="Add visible popular tracks to queue"',
        'aria-label="Close enrichment failures"',
        'aria-label="Select all failures on this page"',
        'title="Delete failure record"',
        'toast.error("Failed to load series")',
        'toast.success("Playing peer playlist")',
        ">Save a copy<",
        ">See more<",
    ];

    for (const literal of forbidden) {
        assert.equal(source.includes(literal), false, literal);
    }
});
