import assert from "node:assert/strict";
import test from "node:test";
import {
    getNextTrackDislikeSignal,
    getNextTrackPreferenceSignal,
} from "../../hooks/trackPreferenceSignals";

test("like toggle sets thumbs_up for clear or thumbs_down state", () => {
    assert.equal(getNextTrackPreferenceSignal("clear"), "thumbs_up");
    assert.equal(getNextTrackPreferenceSignal("thumbs_down"), "thumbs_up");
});

test("like toggle clears when thumbs_up is already active", () => {
    assert.equal(getNextTrackPreferenceSignal("thumbs_up"), "clear");
});

test("dislike toggle sets thumbs_down for clear or thumbs_up state", () => {
    assert.equal(getNextTrackDislikeSignal("clear"), "thumbs_down");
    assert.equal(getNextTrackDislikeSignal("thumbs_up"), "thumbs_down");
});

test("dislike toggle clears when thumbs_down is already active", () => {
    assert.equal(getNextTrackDislikeSignal("thumbs_down"), "clear");
});
