import assert from "node:assert/strict";
import { after, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import { TasteProfileDialog } from "../../features/taste-profile/components/TasteProfileDialog";
import type { TasteProfileSelection } from "../../features/taste-profile/types";
import { api } from "../../lib/api";

GlobalRegistrator.register({ url: "https://soundspan.test/" });
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

after(() => {
    GlobalRegistrator.unregister();
});

function findButton(container: ParentNode, label: string) {
    return Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === label,
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

async function reviewSelection(container: ParentNode) {
    const review = findButton(container, "Дальше: проверить выбор");
    assert.ok(review);
    await React.act(async () => review.click());
    assert.match(container.textContent ?? "", /Шаг 3 из 3/);
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
    const startedAt = Date.now();
    while (!condition()) {
        if (Date.now() - startedAt >= timeoutMs) {
            assert.fail("condition was not met before timeout");
        }
        await React.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
    }
}

test("onboarding is a Russian accessible dialog and explains that it does not create likes", async () => {
    const mounted = await mountDialog();
    const dialog = mounted.container.querySelector('[role="dialog"]');

    assert.ok(dialog);
    assert.equal(dialog.getAttribute("data-taste-stage"), "spectral");
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.ok(dialog.getAttribute("aria-labelledby"));
    assert.ok(dialog.getAttribute("aria-describedby"));
    assert.match(dialog.textContent ?? "", /Настроим музыку под вас/);
    assert.match(dialog.textContent ?? "", /не ставит лайки автоматически/i);
    assert.match(dialog.textContent ?? "", /Шаг 1 из 3/);

    await mounted.cleanup();
});

test("a listener can choose genres, add an artist, and save 3 real taste signals", async () => {
    const mounted = await mountDialog();
    const rock = findButton(mounted.container, "Рок");
    const metal = findButton(mounted.container, "Метал");
    assert.ok(rock);
    assert.ok(metal);

    await React.act(async () => {
        rock.click();
        metal.click();
    });
    assert.equal(rock.getAttribute("aria-pressed"), "true");

    const next = findButton(mounted.container, "Дальше: артисты");
    assert.ok(next);
    await React.act(async () => next.click());

    const artist = findButton(mounted.container, "Linkin Park");
    assert.ok(artist);
    await React.act(async () => artist.click());

    await reviewSelection(mounted.container);
    const save = findButton(mounted.container, "Сохранить вкусы");
    assert.ok(save);
    assert.equal(save.disabled, false);
    await React.act(async () => save.click());

    assert.deepEqual(mounted.saves, [
        { genres: ["Рок", "Метал"], artists: ["Linkin Park"] },
    ]);
    await mounted.cleanup();
});

test("the artist step is rebuilt from the listener's selected genres", async () => {
    const mounted = await mountDialog();
    for (const genre of ["Хип-хоп", "Поп", "Электроника"]) {
        const choice = findButton(mounted.container, genre);
        assert.ok(choice);
        await React.act(async () => choice.click());
    }

    const next = findButton(mounted.container, "Дальше: артисты");
    assert.ok(next);
    await React.act(async () => next.click());

    assert.ok(findButton(mounted.container, "Kendrick Lamar"));
    assert.ok(findButton(mounted.container, "Dua Lipa"));
    assert.ok(findButton(mounted.container, "Daft Punk"));
    assert.equal(findButton(mounted.container, "Rammstein"), undefined);
    assert.equal(
        findButton(mounted.container, "Bring Me The Horizon"),
        undefined,
    );
    await mounted.cleanup();
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
        const next = findButton(mounted.container, "Дальше: артисты");
        assert.ok(next);
        await React.act(async () => next.click());

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

        await reviewSelection(mounted.container);
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
        const next = findButton(mounted.container, "Дальше: артисты");
        assert.ok(next);
        await React.act(async () => next.click());
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
        const next = findButton(mounted.container, "Дальше: артисты");
        assert.ok(next);
        await React.act(async () => next.click());
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

        assert.match(
            mounted.container.textContent ?? "",
            /Рок · Метал · Massive Wagons/,
        );
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
        const next = findButton(editor.container, "Дальше: артисты");
        assert.ok(next);
        await React.act(async () => next.click());
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
    const next = findButton(mounted.container, "Дальше: артисты");
    assert.ok(next);
    await React.act(async () => next.click());
    await reviewSelection(mounted.container);
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

test("genre search, artist filters, and review preserve editable saved choices", async () => {
    const mounted = await mountDialog({
        mode: "edit",
        initialSelection: {
            genres: ["Редкий сохранённый жанр", "Джаз"],
            artists: ["Nina Simone"],
        },
    });
    try {
        const genreSearch = mounted.container.querySelector<HTMLInputElement>(
            'input[aria-label="Найти жанр"]',
        );
        assert.ok(genreSearch);
        await React.act(async () => typeInto(genreSearch, "русск"));
        assert.ok(findButton(mounted.container, "Русский рок"));
        assert.equal(findButton(mounted.container, "Техно"), undefined);
        await React.act(async () =>
            findButton(mounted.container, "Дальше: артисты")!.click(),
        );
        const filter = mounted.container.querySelector<HTMLSelectElement>(
            'select[aria-label="Фильтр артистов по жанру"]',
        );
        assert.ok(filter);
        await React.act(async () => {
            filter.value = "K-pop";
            filter.dispatchEvent(new Event("change", { bubbles: true }));
        });
        assert.ok(findButton(mounted.container, "BTS"));
        assert.equal(findButton(mounted.container, "Linkin Park"), undefined);
        await React.act(async () =>
            findButton(mounted.container, "BTS")!.click(),
        );
        await reviewSelection(mounted.container);
        const remove = mounted.container.querySelector<HTMLButtonElement>(
            'button[aria-label="Убрать жанр: Редкий сохранённый жанр"]',
        );
        assert.ok(remove);
        await React.act(async () => remove.click());
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
