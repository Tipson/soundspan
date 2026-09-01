import assert from "node:assert/strict";
import test from "node:test";
import { preserveDiscoverPrefixData } from "../../features/search/discoverSearchPlaceholder";

const previous = { results: [{ type: "track", name: "Numb" }] };

test("discover prefix retains rows only while expanding the same search", () => {
    assert.equal(
        preserveDiscoverPrefixData(
            previous,
            ["search", "discover", "linkin park", "music", 50],
            "linkin park",
            "music",
        ),
        previous,
    );
    assert.equal(
        preserveDiscoverPrefixData(
            previous,
            ["search", "discover", "linkin park", "music", 50],
            "kino",
            "music",
        ),
        undefined,
    );
});
