import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = [
    "../../app/audiobooks/page.tsx",
    "../../app/audiobooks/[id]/page.tsx",
    "../../features/audiobook/hooks/useAudiobookActions.ts",
]
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");

test("audiobook detail and progress actions expose Russian copy", () => {
    for (const phrase of [
        "Аудиокнига не найдена",
        "Ваша библиотека Audiobookshelf",
        "Продолжить слушать",
        "Аудиокниги не найдены",
        "Отмечено как прослушанное",
        "Прогресс сброшен",
        "Не удалось сбросить прогресс",
    ]) {
        assert.match(source, new RegExp(phrase), phrase);
    }

    for (const phrase of [
        "Audiobook not found",
        "Your Audiobookshelf library",
        "Continue Listening",
        "No audiobooks found",
        "Marked as completed",
        "Progress reset",
        "Failed to reset progress",
    ]) {
        assert.equal(source.includes(`"${phrase}"`), false, phrase);
    }
});
