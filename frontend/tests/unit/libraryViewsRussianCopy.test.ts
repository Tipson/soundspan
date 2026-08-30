import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const files = [
    "../../app/my-history/page.tsx",
    "../../app/playlists/page.tsx",
    "../../features/library/components/AlbumsGrid.tsx",
    "../../features/library/components/ArtistsGrid.tsx",
    "../../features/library/components/TracksList.tsx",
    "../../features/library/hooks/useSavedMusic.ts",
];

const sources = files.map((path) =>
    readFileSync(new URL(path, import.meta.url), "utf8"),
);
const visibleEnglish = [
    "My History",
    "Recently Played",
    "No listening history yet",
    "Browse Library",
    "Play playlists",
    "Play playlist",
    "Playlist source",
    "No playlists yet",
    "No hidden playlists",
    "No peer playlists",
    "My Liked",
    "No albums yet",
    "No artists yet",
    "No songs yet",
    "Delete album",
    "Delete artist",
    "Delete track",
    "Saved to your Library",
    "Removed from Library",
];

test("personal library and history keep product-owned copy Russian", () => {
    const source = sources.join("\n");

    for (const phrase of visibleEnglish) {
        assert.equal(source.includes(`"${phrase}"`), false, phrase);
    }

    for (const phrase of [
        "История прослушиваний",
        "Недавно слушали",
        "Любимые треки",
        "Источник плейлистов",
        "Альбомов пока нет",
        "Исполнителей пока нет",
        "Треков пока нет",
    ]) {
        assert.match(source, new RegExp(phrase), phrase);
    }
});
