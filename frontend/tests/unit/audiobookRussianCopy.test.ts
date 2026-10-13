import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AudiobookHero } from "../../features/audiobook/components/AudiobookHero";
import { AudiobookActionBar } from "../../features/audiobook/components/AudiobookActionBar";
import type { Audiobook } from "../../features/audiobook/types";

const book: Audiobook = {
    id: "book-1",
    title: "Очень длинное название книги",
    author: "Автор",
    coverUrl: null,
    duration: 3600,
    sectionKind: "none",
    sections: [],
    sectionsPlayable: false,
    progress: {
        currentTime: 900,
        progress: 25,
        isFinished: false,
        lastPlayedAt: "2026-10-12",
    },
};

test("audiobook identity renders factual progress and Russian metadata", () => {
    const render = (audiobook: Audiobook) =>
        renderToStaticMarkup(
            React.createElement(AudiobookHero, {
                audiobook,
                heroImage: null,
                colors: null,
                metadata: {
                    narrator: "Чтец",
                    genre: null,
                    publishedYear: null,
                    description: null,
                },
                formatTime: () => "1 ч",
            }),
        );
    const active = render(book);
    assert.match(active, />Аудиокнига</);
    assert.match(active, /Очень длинное название книги/);
    assert.match(active, /Чтец/);
    assert.match(active, /25% прослушано/);
    assert.match(
        render({
            ...book,
            progress: { ...book.progress!, isFinished: true, progress: 100 },
        }),
        />Прослушано</,
    );
});

test("audiobook actions retain named resume, pause, completion and reset controls", () => {
    const render = (overrides: Record<string, unknown>) =>
        renderToStaticMarkup(
            React.createElement(AudiobookActionBar, {
                audiobook: book,
                onPlayPause() {},
                onResetProgress() {},
                onMarkAsCompleted() {},
                ...overrides,
            }),
        );
    const active = render({});
    assert.match(active, /title="Продолжить"/);
    assert.match(active, /title="Сбросить прогресс"/);
    assert.match(active, /title="Отметить как прослушанную"/);
    assert.match(
        render({ isThisBookPlaying: true, isPlaying: true }),
        /title="Пауза"/,
    );
    const completed = render({
        audiobook: {
            ...book,
            progress: { ...book.progress!, isFinished: true },
        },
    });
    assert.match(completed, /title="Слушать снова"/);
    assert.doesNotMatch(completed, /title="Отметить как прослушанную"/);
});
