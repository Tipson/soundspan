"use client";

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { ru } from "@/lib/i18n/ru";

const tabs = [
    { id: "profile", label: "Профиль", hash: "account" },
    { id: "playback", label: "Прослушивание", hash: "playback" },
    { id: "offline", label: "Офлайн", hash: "device-offline" },
    { id: "security", label: "Безопасность", hash: "sign-in-security" },
] as const;

type UserSettingsTab = (typeof tabs)[number]["id"];

const legacySections: Readonly<Record<string, UserSettingsTab>> = {
    account: "profile",
    "taste-profile": "profile",
    social: "profile",
    playback: "playback",
    history: "playback",
    "device-offline": "offline",
    "sign-in-security": "security",
    "api-keys": "security",
};

interface UserSettingsLayoutProps {
    sections: Record<UserSettingsTab, ReactNode>;
    saveDock?: ReactNode;
}

/** Four account-facing pages; visited panels retain unsaved local input. */
export function UserSettingsLayout({
    sections,
    saveDock,
}: UserSettingsLayoutProps) {
    const [active, setActive] = useState<UserSettingsTab>("profile");
    const [visited, setVisited] = useState<ReadonlySet<UserSettingsTab>>(
        () => new Set(["profile"]),
    );
    const tabList = useRef<HTMLDivElement>(null);

    const activate = useCallback((id: UserSettingsTab) => {
        setActive(id);
        setVisited((previous) =>
            previous.has(id) ? previous : new Set([...previous, id]),
        );
    }, []);

    useEffect(() => {
        const restore = () => {
            let hash: string;
            try {
                hash = decodeURIComponent(window.location.hash.slice(1));
            } catch {
                return;
            }
            activate(
                Object.hasOwn(legacySections, hash)
                    ? legacySections[hash]
                    : "profile",
            );
        };
        restore();
        window.addEventListener("popstate", restore);
        window.addEventListener("hashchange", restore);
        return () => {
            window.removeEventListener("popstate", restore);
            window.removeEventListener("hashchange", restore);
        };
    }, [activate]);

    const navigate = (id: UserSettingsTab) => {
        activate(id);
        const tab = tabs.find((item) => item.id === id);
        if (!tab) return;
        const url = new URL(window.location.href);
        if (url.hash !== `#${tab.hash}`) {
            url.hash = tab.hash;
            window.history.pushState({}, "", url);
        }
    };

    return (
        <div className="settings-page min-h-full">
            <div className="mx-auto max-w-4xl px-4 py-6 sm:px-8 md:py-10">
                <header className="mb-6">
                    <h1 className="font-display text-3xl font-bold tracking-tight text-content md:text-4xl">
                        {ru.settings.title}
                    </h1>
                    <p className="mt-2 text-sm leading-6 text-content-muted">
                        Ваш профиль, звучание и музыка на этом устройстве.
                    </p>
                </header>
                <div className="mb-6 rounded-2xl border border-line bg-surface-raised p-2">
                    <label
                        className="block px-2 pb-1 text-xs text-content-muted sm:hidden"
                        htmlFor="user-settings-section"
                    >
                        Раздел настроек
                    </label>
                    <select
                        id="user-settings-section"
                        value={active}
                        onChange={(event) => {
                            const tab = tabs.find(
                                (item) => item.id === event.target.value,
                            );
                            if (tab) navigate(tab.id);
                        }}
                        className="min-h-11 w-full rounded-xl border border-line bg-surface-elevated px-3 text-base text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand sm:hidden"
                    >
                        {tabs.map((tab) => (
                            <option key={tab.id} value={tab.id}>
                                {tab.label}
                            </option>
                        ))}
                    </select>
                    <div
                        ref={tabList}
                        role="tablist"
                        aria-label="Разделы настроек"
                        className="hidden gap-1 sm:flex"
                    >
                        {tabs.map((tab, index) => (
                            <button
                                key={tab.id}
                                type="button"
                                role="tab"
                                id={`settings-tab-${tab.id}`}
                                aria-controls={`settings-panel-${tab.id}`}
                                aria-selected={active === tab.id}
                                tabIndex={active === tab.id ? 0 : -1}
                                onClick={() => navigate(tab.id)}
                                onKeyDown={(event) => {
                                    const next =
                                        event.key === "Home"
                                            ? 0
                                            : event.key === "End"
                                              ? tabs.length - 1
                                              : event.key === "ArrowRight"
                                                ? (index + 1) % tabs.length
                                                : event.key === "ArrowLeft"
                                                  ? (index + tabs.length - 1) %
                                                    tabs.length
                                                  : null;
                                    if (next === null) return;
                                    event.preventDefault();
                                    navigate(tabs[next].id);
                                    tabList.current
                                        ?.querySelectorAll<HTMLButtonElement>(
                                            '[role="tab"]',
                                        )
                                        [next]?.focus();
                                }}
                                className={`min-h-11 flex-1 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none ${active === tab.id ? "bg-brand text-black" : "text-content-muted hover:bg-surface-hover hover:text-content"}`}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>
                </div>
                {tabs.map((tab) => (
                    <div
                        key={tab.id}
                        id={`settings-panel-${tab.id}`}
                        role="tabpanel"
                        aria-labelledby={`settings-tab-${tab.id}`}
                        hidden={active !== tab.id}
                        className="min-w-0 space-y-4 md:space-y-5"
                    >
                        {visited.has(tab.id) ? sections[tab.id] : null}
                    </div>
                ))}
                {saveDock}
            </div>
        </div>
    );
}
