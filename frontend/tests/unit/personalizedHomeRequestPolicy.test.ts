import assert from "node:assert/strict";
import test from "node:test";
import {
    PERSONALIZED_HOME_QUERY_RETRY,
    PERSONALIZED_HOME_REQUEST_TIMEOUT_MS,
    PERSONALIZED_HOME_TIMEOUT_RETRY,
} from "../../features/home/hooks/usePersonalizedHomeFeed";

test("personalized home has one outer request budget and no multiplying retries", () => {
    assert.equal(PERSONALIZED_HOME_REQUEST_TIMEOUT_MS, 17_000);
    assert.equal(PERSONALIZED_HOME_TIMEOUT_RETRY, false);
    assert.equal(PERSONALIZED_HOME_QUERY_RETRY, false);
});
