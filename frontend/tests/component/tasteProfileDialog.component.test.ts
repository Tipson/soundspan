import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { after, beforeEach, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import { TasteProfileDialog } from "../../features/taste-profile/components/TasteProfileDialog";
import type { TasteProfileSelection } from "../../features/taste-profile/types";
import { api } from "../../lib/api";
import {
    SUGGESTED_GENRES,
    suggestArtistsForGenres,
} from "../../features/taste-profile/suggestions";

test("catalog pages continue beyond curated suggestions and keep selections", async () => {
    const pages: number[] = [];
    api.request = (async (path: string) => {
        if (!path.includes("/artists?")) return { image: null };
        const page = Number(
            new URL(path, "https://test").searchParams.get("page"),
        );
        pages.push(page);
        return {
            artists:
                page === 1
                    ? ["Catalog A", "Catalog B"]
                    : ["Catalog B", "Catalog C"],
            nextPage: page === 1 ? 2 : null,
        };
    }) as typeof api.request;
    const mounted = await mountDialog();
    try {
        await waitFor(() =>
            Boolean(findButton(mounted.container, "Catalog A")),
        );
        await React.act(async () =>
            findButton(mounted.container, "Catalog A")!.click(),
        );
        await React.act(async () =>
            findButton(mounted.container, "Ещё артисты")!.click(),
        );
        await waitFor(() =>
            Boolean(findButton(mounted.container, "Catalog C")),
        );
        assert.deepEqual(pages, [1, 2]);
        assert.equal(
            mounted.container.querySelectorAll('[aria-label="Catalog B"]')
                .length,
            1,
        );
        assert.equal(
            findButton(mounted.container, "Catalog A")!.getAttribute(
                "aria-pressed",
            ),
            "true",
        );
        assert.equal(findButton(mounted.container, "Ещё артисты"), undefined);
    } finally {
        await mounted.cleanup();
    }
});

test("catalog failure retries the same page without dropping artists or selection", async () => {
    let fail = true;
    api.request = (async (path: string) => {
        if (!path.includes("/artists?")) return { image: null };
        const page = Number(
            new URL(path, "https://test").searchParams.get("page"),
        );
        if (page === 2 && fail) throw new Error("offline");
        return {
            artists: page === 1 ? ["Catalog A"] : ["Catalog B"],
            nextPage: page === 1 ? 2 : null,
        };
    }) as typeof api.request;
    const mounted = await mountDialog();
    try {
        await waitFor(() =>
            Boolean(findButton(mounted.container, "Catalog A")),
        );
        await React.act(async () =>
            findButton(mounted.container, "Catalog A")!.click(),
        );
        await React.act(async () =>
            findButton(mounted.container, "Ещё артисты")!.click(),
        );
        await waitFor(() =>
            Boolean(findButton(mounted.container, "Повторить загрузку")),
        );
        assert.equal(
            findButton(mounted.container, "Catalog A")!.getAttribute(
                "aria-pressed",
            ),
            "true",
        );
        fail = false;
        await React.act(async () =>
            findButton(mounted.container, "Повторить загрузку")!.click(),
        );
        await waitFor(() =>
            Boolean(findButton(mounted.container, "Catalog B")),
        );
    } finally {
        await mounted.cleanup();
    }
});

test("changing genre aborts the old catalog and ignores its delayed response", async () => {
    let finishOld!: (value: unknown) => void;
    let oldSignal: AbortSignal | undefined;
    api.request = (async (path: string, options?: { signal?: AbortSignal }) => {
        if (!path.includes("/artists?")) return { image: null };
        const genre = new URL(path, "https://test").searchParams.get("genre");
        if (genre === "all") {
            oldSignal = options?.signal;
            return new Promise<unknown>((resolve) => {
                finishOld = resolve;
            });
        }
        return { artists: ["Rock Artist"], nextPage: null };
    }) as typeof api.request;
    const mounted = await mountDialog();
    try {
        await chooseGenre(mounted.container, "Рок");
        await waitFor(() =>
            Boolean(findButton(mounted.container, "Rock Artist")),
        );
        assert.equal(oldSignal?.aborted, true);
        await React.act(async () =>
            finishOld({ artists: ["Stale Artist"], nextPage: null }),
        );
        assert.equal(findButton(mounted.container, "Stale Artist"), undefined);
    } finally {
        await mounted.cleanup();
    }
});

test("every genre offers a meaningful selection beyond the former five artists", () => {
    for (const genre of SUGGESTED_GENRES) {
        const artists = suggestArtistsForGenres([genre], 100);
        assert.ok(artists.length >= 12, `${genre}: ${artists.length}`);
        assert.equal(
            new Set(artists.map((name) => name.toLowerCase())).size,
            artists.length,
        );
    }
});

async function chooseGenre(container: ParentNode, genre: string) {
    await React.act(async () => findButton(container, "Все жанры")!.click());
    const panel = container.querySelector('[aria-label="Все жанры"]');
    assert.ok(panel);
    await React.act(async () =>
        findButton(panel, genre === "all" ? "Все исполнители" : genre)!.click(),
    );
}

test("genre navigation has a clear all-artists choice and keeps controls outside the scrolling results", async () => {
    const mounted = await mountDialog();
    try {
        const trigger = findButton(mounted.container, "Все жанры")!;
        assert.ok(trigger);
        assert.equal(mounted.container.querySelector("select"), null);
        const scroll = mounted.container.querySelector(
            '[data-testid="taste-profile-scroll-region"]',
        )!;
        assert.equal(scroll.contains(trigger), false);
        await chooseGenre(mounted.container, "Рок");
        assert.ok(
            scroll.querySelectorAll('[aria-label="Исполнители"] button')
                .length >= 12,
        );
        assert.ok(findButton(mounted.container, "Queen"));
    } finally {
        await mounted.cleanup();
    }
});

GlobalRegistrator.register({ url: "https://soundspan.test/" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
    api.request = (async () => ({ image: null })) as typeof api.request;
});

after(() => {
    GlobalRegistrator.unregister();
});

function findButton(container: ParentNode, label: string) {
    return Array.from(container.querySelectorAll("button")).find(
        (button) =>
            button.textContent?.trim() === label ||
            button.getAttribute("aria-label") === label,
    );
}

function typeInto(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
    )?.set;
    assert.ok(setter, "expected the input value setter");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mountDialog(
    overrides: Partial<React.ComponentProps<typeof TasteProfileDialog>> = {},
) {
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    });
    const saves: TasteProfileSelection[] = [];
    let skips = 0;
    let closes = 0;
    const props: React.ComponentProps<typeof TasteProfileDialog> = {
        mode: "onboarding",
        initialSelection: { genres: [], artists: [] },
        isSaving: false,
        error: null,
        onSave: async (selection) => {
            saves.push(selection);
        },
        onSkip: async () => {
            skips += 1;
        },
        onClose: () => {
            closes += 1;
        },
        ...overrides,
    };
    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(TasteProfileDialog, props),
            ),
        );
    });
    return {
        container,
        saves,
        get skips() {
            return skips;
        },
        get closes() {
            return closes;
        },
        cleanup: async () => {
            await React.act(async () => root.unmount());
            container.remove();
            queryClient.clear();
        },
    };
}

async function waitFor(
    condition: () => boolean,
    timeoutMs: number = 1_000,
): Promise<void> {
    // WSL wall-clock corrections can jump forward during a concurrent suite.
    // An elapsed timeout must use the monotonic Node clock instead.
    const startedAt = performance.now();
    while (!condition()) {
        if (performance.now() - startedAt >= timeoutMs) {
            assert.fail("condition was not met before timeout");
        }
        await React.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
    }
}

test("DOM readiness waits survive a forward wall-clock adjustment", async (t) => {
    let wallClockReads = 0;
    t.mock.method(Date, "now", () => (wallClockReads++ === 0 ? 0 : 60_000));
    let ready = false;
    const readyTimer = setTimeout(() => {
        ready = true;
    }, 20);
    try {
        await waitFor(() => ready);
        assert.equal(ready, true);
    } finally {
        clearTimeout(readyTimer);
    }
});

test("onboarding is a Russian accessible dialog and explains that it does not create likes", async () => {
    const mounted = await mountDialog();
    const dialog = mounted.container.querySelector('[role="dialog"]');

    assert.ok(dialog);
    assert.equal(dialog.getAttribute("data-taste-stage"), "artists");
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.ok(dialog.getAttribute("aria-labelledby"));
    assert.equal(dialog.getAttribute("aria-describedby"), null);
    assert.match(dialog.textContent ?? "", /Любимые исполнители/);
    assert.doesNotMatch(
        dialog.textContent ?? "",
        /не ставит лайки автоматически/i,
    );
    assert.doesNotMatch(dialog.textContent ?? "", /Шаг \d из/);
    assert.ok(findButton(mounted.container, "Сохранить вкусы"));

    await mounted.cleanup();
});

test("artist-first setup preserves limits and saves directly without genre signals from filters", async () => {
    const mounted = await mountDialog();
    try {
        const save = findButton(mounted.container, "Сохранить вкусы")!;
        assert.equal(save.disabled, false);
        await chooseGenre(mounted.container, "Рок");
        for (const name of ["Linkin Park", "Muse", "Queen"]) {
            const artist = findButton(mounted.container, name);
            assert.ok(artist);
            await React.act(async () => artist.click());
            assert.equal(artist.getAttribute("aria-pressed"), "true");
        }
        assert.equal(save.disabled, false);
        await React.act(async () => save.click());
        assert.deepEqual(mounted.saves, [
            { genres: [], artists: ["Linkin Park", "Muse", "Queen"] },
        ]);
        assert.ok(
            mounted.container.querySelector(
                '[data-testid="taste-profile-scroll-region"]',
            ),
        );
    } finally {
        await mounted.cleanup();
    }
});

test("ten selected artists still allow more choices and removal", async () => {
    const artists = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    const mounted = await mountDialog({
        initialSelection: { genres: [], artists },
    });
    try {
        await chooseGenre(mounted.container, "Рок");
        assert.equal(findButton(mounted.container, "Muse")!.disabled, false);
        await React.act(async () =>
            findButton(mounted.container, "Убрать артиста: A")!.click(),
        );
        assert.equal(findButton(mounted.container, "Muse")!.disabled, false);
    } finally {
        await mounted.cleanup();
    }
});

test("artist search selects the provider's canonical artist instead of saving raw input", async () => {
    const originalSearch = api.searchMusicBrainzArtists;
    const searches: string[] = [];
    api.searchMusicBrainzArtists = async (query: string) => {
        searches.push(query);
        return {
            artists: [
                {
                    mbid: "10adbe51-1a05-4f31-962d-b59c114ab2f8",
                    name: "Massive Attack",
                    disambiguation: "British trip hop group",
                    country: "GB",
                    type: "Group",
                    score: 100,
                },
            ],
        };
    };

    const mounted = await mountDialog({
        initialSelection: { genres: ["Хип-хоп", "Электроника"], artists: [] },
    });
    try {
        const input = mounted.container.querySelector<HTMLInputElement>(
            'input[aria-label="Найти или добавить артиста"]',
        );
        assert.ok(input);
        await React.act(async () => {
            typeInto(input, "  massive att  ");
        });
        await waitFor(
            () =>
                mounted.container.querySelector(
                    '[data-artist-mbid="10adbe51-1a05-4f31-962d-b59c114ab2f8"]',
                ) !== null,
        );

        assert.deepEqual(searches, ["massive att"]);
        const canonicalResult =
            mounted.container.querySelector<HTMLButtonElement>(
                '[data-artist-mbid="10adbe51-1a05-4f31-962d-b59c114ab2f8"]',
            );
        assert.ok(canonicalResult);
        await React.act(async () => canonicalResult.click());
        const save = findButton(mounted.container, "Сохранить вкусы");
        assert.ok(save);
        assert.equal(save.disabled, false);
        await React.act(async () => save.click());
        assert.deepEqual(mounted.saves, [
            {
                genres: ["Хип-хоп", "Электроника"],
                artists: ["Massive Attack"],
            },
        ]);
    } finally {
        api.searchMusicBrainzArtists = originalSearch;
        await mounted.cleanup();
    }
});

test("pressing Enter during a changed query cannot select stale provider results", async () => {
    const originalSearch = api.searchMusicBrainzArtists;
    api.searchMusicBrainzArtists = async (query: string) => ({
        artists: [
            query === "massive"
                ? {
                      mbid: "10adbe51-1a05-4f31-962d-b59c114ab2f8",
                      name: "Massive Attack",
                      disambiguation: null,
                      country: "GB",
                      type: "Group",
                      score: 100,
                  }
                : {
                      mbid: "056e4f3e-d505-4dad-8ec1-d04f521cbb56",
                      name: "Daft Punk",
                      disambiguation: null,
                      country: "FR",
                      type: "Group",
                      score: 100,
                  },
        ],
    });
    const mounted = await mountDialog({
        initialSelection: { genres: ["Поп", "Электроника"], artists: [] },
    });
    try {
        const input = mounted.container.querySelector<HTMLInputElement>(
            'input[aria-label="Найти или добавить артиста"]',
        );
        assert.ok(input);

        await React.act(async () => typeInto(input, "massive"));
        await waitFor(
            () =>
                mounted.container.querySelector(
                    '[data-artist-mbid="10adbe51-1a05-4f31-962d-b59c114ab2f8"]',
                ) !== null,
        );
        await React.act(async () => typeInto(input, "daft"));
        await React.act(async () => {
            input.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
            );
        });

        assert.doesNotMatch(
            mounted.container.textContent ?? "",
            /Поп · Электроника · Massive Attack/,
        );
        await waitFor(
            () =>
                mounted.container.querySelector(
                    '[data-artist-mbid="056e4f3e-d505-4dad-8ec1-d04f521cbb56"]',
                ) !== null,
        );
    } finally {
        api.searchMusicBrainzArtists = originalSearch;
        await mounted.cleanup();
    }
});

test("artist autocomplete exposes and selects the keyboard-active canonical option", async () => {
    const originalSearch = api.searchMusicBrainzArtists;
    api.searchMusicBrainzArtists = async () => ({
        artists: [
            {
                mbid: "10adbe51-1a05-4f31-962d-b59c114ab2f8",
                name: "Massive Attack",
                disambiguation: null,
                country: "GB",
                type: "Group",
                score: 100,
            },
            {
                mbid: "f507779e-8ce8-4a15-8a1c-59a0f42c31e4",
                name: "Massive Wagons",
                disambiguation: null,
                country: "GB",
                type: "Group",
                score: 90,
            },
        ],
    });
    const mounted = await mountDialog({
        initialSelection: { genres: ["Рок", "Метал"], artists: [] },
    });
    try {
        const input = mounted.container.querySelector<HTMLInputElement>(
            'input[aria-label="Найти или добавить артиста"]',
        );
        assert.ok(input);

        await React.act(async () => typeInto(input, "massive"));
        await waitFor(
            () =>
                mounted.container.querySelector(
                    '[data-artist-mbid="f507779e-8ce8-4a15-8a1c-59a0f42c31e4"]',
                ) !== null,
        );
        assert.equal(
            input.getAttribute("aria-activedescendant"),
            "taste-artist-option-10adbe51-1a05-4f31-962d-b59c114ab2f8",
        );

        await React.act(async () => {
            input.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "ArrowDown",
                    bubbles: true,
                }),
            );
        });
        assert.equal(
            input.getAttribute("aria-activedescendant"),
            "taste-artist-option-f507779e-8ce8-4a15-8a1c-59a0f42c31e4",
        );
        await React.act(async () => {
            input.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
            );
        });

        assert.match(mounted.container.textContent ?? "", /Massive Wagons/);
    } finally {
        api.searchMusicBrainzArtists = originalSearch;
        await mounted.cleanup();
    }
});

test("onboarding skip remains an explicit action", async () => {
    const mounted = await mountDialog();
    const skip = findButton(mounted.container, "Пропустить настройку");
    assert.ok(skip);
    await React.act(async () => skip.click());
    assert.equal(mounted.skips, 1);
    assert.equal(mounted.closes, 0);
    await mounted.cleanup();
});

test("editing can be dismissed with Escape while mandatory onboarding uses its explicit skip", async () => {
    const editor = await mountDialog({ mode: "edit" });
    await React.act(async () => {
        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    });
    assert.equal(editor.closes, 1);
    await editor.cleanup();

    const onboarding = await mountDialog();
    await React.act(async () => {
        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    });
    assert.equal(onboarding.closes, 0);
    await onboarding.cleanup();
});

test("Escape clears artist autocomplete before closing the taste editor", async () => {
    const originalSearch = api.searchMusicBrainzArtists;
    api.searchMusicBrainzArtists = async () => ({ artists: [] });
    const editor = await mountDialog({
        mode: "edit",
        initialSelection: { genres: ["Рок", "Метал"], artists: [] },
    });
    try {
        const input = editor.container.querySelector<HTMLInputElement>(
            'input[aria-label="Найти или добавить артиста"]',
        );
        assert.ok(input);

        await React.act(async () => typeInto(input, "massive"));
        assert.equal(input.value, "massive");
        await React.act(async () => {
            input.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "Escape",
                    bubbles: true,
                }),
            );
        });

        assert.equal(input.value, "");
        assert.equal(editor.closes, 0);

        await React.act(async () => {
            document.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "Escape",
                    bubbles: true,
                }),
            );
        });
        assert.equal(editor.closes, 1);
    } finally {
        api.searchMusicBrainzArtists = originalSearch;
        await editor.cleanup();
    }
});

test("rapid repeated save clicks start only one provider-backed write", async () => {
    let saveCalls = 0;
    let resolveSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => {
        resolveSave = resolve;
    });
    const mounted = await mountDialog({
        initialSelection: {
            genres: ["Рок"],
            artists: ["Кино", "Muse"],
        },
        onSave: async () => {
            saveCalls += 1;
            await pendingSave;
        },
    });
    const save = findButton(mounted.container, "Сохранить вкусы");
    assert.ok(save);

    await React.act(async () => {
        save.click();
        save.click();
        await Promise.resolve();
    });
    assert.equal(saveCalls, 1);

    await React.act(async () => {
        resolveSave();
        await pendingSave;
    });
    await mounted.cleanup();
});

test("genre filters preserve saved genres and artists and let the listener remove either", async () => {
    const mounted = await mountDialog({
        mode: "edit",
        initialSelection: {
            genres: ["Редкий сохранённый жанр", "Джаз"],
            artists: ["Nina Simone"],
        },
    });
    try {
        await chooseGenre(mounted.container, "K-pop");
        assert.ok(findButton(mounted.container, "BTS"));
        assert.equal(findButton(mounted.container, "Linkin Park"), undefined);
        await React.act(async () =>
            findButton(mounted.container, "BTS")!.click(),
        );
        await React.act(async () =>
            findButton(
                mounted.container,
                "Убрать жанр: Редкий сохранённый жанр",
            )!.click(),
        );
        await React.act(async () =>
            findButton(mounted.container, "Сохранить вкусы")!.click(),
        );
        assert.deepEqual(mounted.saves, [
            { genres: ["Джаз"], artists: ["Nina Simone", "BTS"] },
        ]);
    } finally {
        await mounted.cleanup();
    }
});

test("focus wraps inside the editor and returns to its opener", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const mounted = await mountDialog({ mode: "edit" });
    try {
        const buttons = Array.from(
            mounted.container.querySelectorAll<HTMLButtonElement>(
                "button:not([disabled]), input:not([disabled])",
            ),
        );
        const first = buttons[0],
            last = buttons[buttons.length - 1];
        await React.act(async () => {
            first.focus();
            first.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "Tab",
                    shiftKey: true,
                    bubbles: true,
                }),
            );
        });
        assert.equal(document.activeElement, last);
        await React.act(async () =>
            last.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
            ),
        );
        assert.equal(document.activeElement, first);
    } finally {
        await mounted.cleanup();
    }
    assert.equal(document.activeElement, opener);
    opener.remove();
});

test("taste setup removes explanatory copy and genre palette closes with Escape", async () => {
    const mounted = await mountDialog({ mode: "edit" });
    try {
        assert.doesNotMatch(
            mounted.container.textContent ?? "",
            /рекомендации на главной|прослушивания и лайки|Количество —|Пока ничего не выбрано|Можно выбрать сколько/i,
        );
        const trigger = findButton(mounted.container, "Все жанры")!;
        await React.act(async () => trigger.click());
        const panel = mounted.container.querySelector(
            '[aria-label="Все жанры"]',
        )!;
        assert.ok(panel);
        assert.ok(findButton(panel, "Джаз"));
        await React.act(async () =>
            panel.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
            ),
        );
        assert.equal(
            mounted.container.querySelector('[aria-label="Все жанры"]'),
            null,
        );
        assert.equal(mounted.closes, 0);
        assert.equal(document.activeElement, trigger);
    } finally {
        await mounted.cleanup();
    }
});

test("portraits appear progressively, limit network concurrency and cancel on close", async (t) => {
    const calls: {
        resolve: (value: { image: string }) => void;
        signal: AbortSignal;
    }[] = [];
    t.mock.method(
        api,
        "request",
        (_path: string, options: { signal: AbortSignal }) =>
            _path.includes("/artists?")
                ? Promise.reject(new Error("offline"))
                : new Promise((resolve, reject) => {
                      calls.push({ resolve, signal: options.signal });
                      options.signal.addEventListener(
                          "abort",
                          () => reject(new Error("aborted")),
                          { once: true },
                      );
                  }),
    );
    const mounted = await mountDialog();
    try {
        assert.equal(calls.length, 3);
        await React.act(async () =>
            calls[0].resolve({ image: "https://images.test/artist.jpg" }),
        );
        await waitFor(
            () =>
                mounted.container.querySelector('img[src*="artist.jpg"]') !==
                null,
        );
        assert.equal(calls.length, 4);
    } finally {
        await mounted.cleanup();
    }
    assert.ok(calls.every((call) => call.signal.aborted));
});
