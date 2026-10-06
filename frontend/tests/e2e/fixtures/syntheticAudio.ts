import type { Route } from "@playwright/test";
/** Create actual PCM audio for native media-clock assertions without a provider. */
export function createSyntheticWav(seconds = 120, sampleRate = 8_000): Buffer {
    const sampleCount = seconds * sampleRate;
    const buffer = Buffer.alloc(44 + sampleCount * 2);
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(buffer.length - 8, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36);
    buffer.writeUInt32LE(sampleCount * 2, 40);
    for (let index = 0; index < sampleCount; index += 1) {
        const sample = Math.round(
            Math.sin((index * Math.PI * 2 * 440) / sampleRate) * 2_000,
        );
        buffer.writeInt16LE(sample, 44 + index * 2);
    }
    return buffer;
}

/** Serve generated audio with byte ranges like the production stream endpoint. */
export async function fulfillAudioRange(
    route: Route,
    audio: Buffer,
): Promise<void> {
    const range = route.request().headers().range;
    const match = /^bytes=(\d+)-(\d*)$/.exec(range ?? "");
    if (!match) {
        await route.fulfill({
            status: 200,
            contentType: "audio/wav",
            headers: {
                "accept-ranges": "bytes",
                "cache-control": "no-store",
                "content-length": String(audio.length),
            },
            body: audio,
        });
        return;
    }

    const start = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) : audio.length - 1;
    const end = Math.min(requestedEnd, audio.length - 1);
    const body = audio.subarray(start, end + 1);
    await route.fulfill({
        status: 206,
        contentType: "audio/wav",
        headers: {
            "accept-ranges": "bytes",
            "cache-control": "no-store",
            "content-length": String(body.length),
            "content-range": `bytes ${start}-${end}/${audio.length}`,
        },
        body,
    });
}
