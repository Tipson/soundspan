import assert from "node:assert/strict";
import { test } from "node:test";
import { getRecommendationSessionId } from "../../lib/recommendationSession";

test("recommendation session fallback is generated from Web Crypto bytes", () => {
    const originalCrypto = globalThis.crypto;
    const originalWindow = Object.getOwnPropertyDescriptor(
        globalThis,
        "window",
    );

    Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: {
            getRandomValues<T extends ArrayBufferView | null>(array: T): T {
                if (array instanceof Uint8Array) {
                    array.set([
                        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
                        0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
                    ]);
                }
                return array;
            },
        },
    });
    Reflect.deleteProperty(globalThis, "window");

    try {
        assert.equal(
            getRecommendationSessionId(),
            "00112233-4455-4677-8899-aabbccddeeff",
        );
    } finally {
        Object.defineProperty(globalThis, "crypto", {
            configurable: true,
            value: originalCrypto,
        });
        if (originalWindow) {
            Object.defineProperty(globalThis, "window", originalWindow);
        }
    }
});
