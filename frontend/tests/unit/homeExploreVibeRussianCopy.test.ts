import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const USER_SURFACES = [
    "app/discover/page.tsx",
    "features/discover/components/DiscoverActionBar.tsx",
    "features/discover/components/DiscoverSettings.tsx",
    "features/discover/components/HowItWorks.tsx",
    "features/home/components/HomeHero.tsx",
    "features/home/components/HomeQuickActions.tsx",
    "features/home/components/PersonalizedTrackShelf.tsx",
    "features/explore/components/MadeForYouSection.tsx",
    "features/explore/components/MoodPills.tsx",
    "components/vibe/FiltersPanel.tsx",
    "components/vibe/QueuePanel.tsx",
    "components/vibe/SpotlightSearch.tsx",
    "components/vibe/ViewControls.tsx",
] as const;

const FORBIDDEN_ENGLISH_COPY = [
    "Good morning",
    "Made For You",
    "Pick a moment",
    "Search this as a vibe",
    "Show filters",
    "Nothing queued",
    "Generate Now",
    "Feature not available",
    "How It Works",
    "Add all to queue",
    "Failed to load preview",
] as const;

test("Home, Explore, Discover and Vibe keep product-owned copy in Russian", () => {
    const source = USER_SURFACES.map((file) =>
        readFileSync(join(process.cwd(), file), "utf8"),
    )
        .join("\n")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");

    for (const phrase of FORBIDDEN_ENGLISH_COPY) {
        assert.equal(
            source.includes(phrase),
            false,
            `user-facing English copy remains: ${phrase}`,
        );
    }
});
