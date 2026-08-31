import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const surfaceFiles = [
    "app/audiobooks/series/[name]/page.tsx",
    "app/podcasts/genre/[genreId]/page.tsx",
    "app/search/loading.tsx",
    "app/setup/page.tsx",
    "components/EnrichmentFailuresModal.tsx",
    "components/track/TrackList.tsx",
    "components/track/TrackRow.tsx",
    "components/track/badges.tsx",
    "components/ui/LibraryBadge.tsx",
    "features/artist/components/PopularTracks.tsx",
    "features/audiobook/components/AudiobookActionBar.tsx",
    "features/audiobook/components/AboutSection.tsx",
    "features/audiobook/components/PlayControls.tsx",
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
        ">Redirecting to login...<",
        ">Genre not found<",
        ">Back to Podcasts<",
        ">No more podcasts to load<",
        ">No podcasts found<",
        ">Pause<",
        ">Finished<",
        ">About<",
        ">IN QUEUE<",
        ">PREVIEW<",
        ">LOADING<",
        ">Save a copy<",
        ">See more<",
    ];

    for (const literal of forbidden) {
        assert.equal(source.includes(literal), false, literal);
    }
});
