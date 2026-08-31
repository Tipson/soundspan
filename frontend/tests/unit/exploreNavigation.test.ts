import assert from "node:assert/strict";
import test from "node:test";
import {
    SIDEBAR_NAVIGATION,
    MOBILE_QUICK_LINKS,
} from "../../components/layout/socialNavigation";

test("sidebar navigation keeps the three primary music destinations", () => {
    assert.deepEqual(
        SIDEBAR_NAVIGATION.map(({ name, href }) => ({ name, href })),
        [
            { name: "Главная", href: "/" },
            { name: "Волна", href: "/vibe" },
            { name: "Моя музыка", href: "/library" },
        ],
    );
});

test("sidebar navigation starts with the unified Home entry", () => {
    assert.equal(SIDEBAR_NAVIGATION[0].name, "Главная");
    assert.equal(SIDEBAR_NAVIGATION[0].href, "/");
});

test("sidebar navigation stays music-first without inactive spoken-word sections", () => {
    const names = SIDEBAR_NAVIGATION.map((item) => item.name);
    assert.ok(names.includes("Моя музыка"), "should include My Music");
    assert.ok(!names.includes("Explore"), "Home now owns Explore content");
    assert.ok(!names.includes("Search"), "search lives in the top bar");
    assert.ok(!names.includes("Listen Together"), "social stays secondary");
    assert.ok(!names.includes("Audiobooks"), "should hide Audiobooks");
    assert.ok(!names.includes("Podcasts"), "should hide Podcasts");
});

test("sidebar navigation does not include removed items", () => {
    const names = SIDEBAR_NAVIGATION.map((item) => item.name);
    assert.ok(!names.includes("My Liked"), "should not include My Liked");
    assert.ok(!names.includes("Radio"), "should not include Radio");
    assert.ok(!names.includes("Discovery"), "should not include Discovery");
    assert.ok(!names.includes("Browse"), "should not include Browse");
});

test("mobile quick links mirror the primary music destinations", () => {
    assert.deepEqual(
        MOBILE_QUICK_LINKS.map(({ name, href }) => ({ name, href })),
        [
            { name: "Главная", href: "/" },
            { name: "Волна", href: "/vibe" },
            { name: "Моя музыка", href: "/library" },
        ],
    );
});
