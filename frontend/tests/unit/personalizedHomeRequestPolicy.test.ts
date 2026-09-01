import assert from "node:assert/strict";
import test from "node:test";
import {
    buildPersonalizedHomeFeedUrl,
    PERSONALIZED_HOME_QUERY_RETRY,
    PERSONALIZED_HOME_REQUEST_TIMEOUT_MS,
    PERSONALIZED_HOME_TIMEOUT_RETRY,
} from "../../features/home/hooks/usePersonalizedHomeFeed";
import { queryKeys } from "../../lib/queryKeys";

test("personalized home has one outer request budget and no multiplying retries", () => {
    assert.equal(PERSONALIZED_HOME_REQUEST_TIMEOUT_MS, 17_000);
    assert.equal(PERSONALIZED_HOME_TIMEOUT_RETRY, false);
    assert.equal(PERSONALIZED_HOME_QUERY_RETRY, false);
});

test("personalized home request and cache key preserve the ranking mode", () => {
    assert.equal(
        buildPersonalizedHomeFeedUrl(24, "new", null, "home", "tab-1"),
        "/personalized/home?limit=24&mode=new&surface=home&sessionId=tab-1",
    );
    assert.deepEqual(queryKeys.personalizedHome(24, "new"), [
        "home",
        "personalized",
        "home",
        24,
        "new",
    ]);
    assert.notDeepEqual(
        queryKeys.personalizedHome(24, "new"),
        queryKeys.personalizedHome(24, "familiar"),
    );
});

test("personalized home request and cache key preserve an independent Wave mood", () => {
    assert.equal(
        buildPersonalizedHomeFeedUrl(24, "new", "focus", "wave", "tab-1"),
        "/personalized/home?limit=24&mode=new&surface=wave&sessionId=tab-1&mood=focus",
    );
    assert.deepEqual(queryKeys.personalizedHome(24, "new", "focus", "wave"), [
        "home",
        "personalized",
        "wave",
        24,
        "new",
        "focus",
    ]);
    assert.notDeepEqual(
        queryKeys.personalizedHome(24, "new", "focus"),
        queryKeys.personalizedHome(24, "new", "workout"),
    );
});

test("personalized cache separates Home and Wave exposure surfaces", () => {
    assert.notDeepEqual(
        queryKeys.personalizedHome(12, "for-you", null, "home"),
        queryKeys.personalizedHome(12, "for-you", null, "wave"),
    );
});
