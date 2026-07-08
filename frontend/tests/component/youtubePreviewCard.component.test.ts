/**
 * Render tests for the single-video YouTube preview card: playback stays
 * available to every authenticated user, while the download affordance is
 * admin-only (canDownload=false hides it entirely).
 */
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = () => React.createElement("i");

mock.module("next/image", {
    defaultExport: ({ src, alt }: { src: string; alt: string }) =>
        React.createElement("img", { src, alt }),
});

mock.module("lucide-react", {
    namedExports: {
        Play: Icon,
        Download: Icon,
        Loader2: Icon,
        ChevronDown: Icon,
    },
});

const VIDEO = {
    videoId: "dQw4w9WgXcQ",
    title: "Test Video",
    uploader: "Test Channel",
    duration: 212,
    thumbnail: "https://img.example/t.jpg",
    uploadDate: "20091025",
} as const;

async function render(props: Record<string, unknown>) {
    const { YouTubePreviewCard } = await import(
        "../../features/search/components/YouTubePreviewCard"
    );
    return renderToStaticMarkup(
        React.createElement(YouTubePreviewCard, {
            videoInfo: VIDEO,
            isLoading: false,
            isDownloading: false,
            downloadProgress: null,
            canDownload: true,
            onPlay: () => undefined,
            onDownload: async () => undefined,
            ...props,
        } as never)
    );
}

test("renders Play and Download for admins", async () => {
    const html = await render({});
    assert.match(html, /Test Video/);
    assert.match(html, />Play</);
    assert.match(html, /Download/);
});

test("hides the Download affordance for non-admin users but keeps Play", async () => {
    const html = await render({ canDownload: false });
    assert.match(html, /Test Video/);
    assert.match(html, />Play</);
    assert.doesNotMatch(html, /Download/);
});

test("hides the download progress bar for non-admin users", async () => {
    const html = await render({
        canDownload: false,
        isDownloading: true,
        downloadProgress: 42,
    });
    assert.doesNotMatch(html, /Downloading/);
});
