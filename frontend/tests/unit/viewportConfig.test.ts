import assert from "node:assert/strict";
import test from "node:test";
import { APP_VIEWPORT } from "../../lib/viewportConfig";

test("mobile viewport keeps pinch zoom available", () => {
    assert.equal(APP_VIEWPORT.width, "device-width");
    assert.equal(APP_VIEWPORT.initialScale, 1);
    assert.equal(APP_VIEWPORT.viewportFit, "cover");
    assert.equal("maximumScale" in APP_VIEWPORT, false);
    assert.equal("userScalable" in APP_VIEWPORT, false);
});
