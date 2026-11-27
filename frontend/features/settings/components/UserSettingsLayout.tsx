"use client";

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type MouseEvent,
    type ReactNode,
} from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { ru } from "@/lib/i18n/ru";

const tabs = [
    {
        id: "profile",
        label: "Профиль",
        hash: "account",
        description: "Аккаунт, музыкальные предпочтения и общение",
    },
    {
        id: "playback",
        label: "Прослушивание",
        hash: "playback",
        description: "Качество звука и история прослушиваний",
    },
    {
        id: "offline",
        label: "Офлайн",
        hash: "device-offline",
        description: "Загрузки на этом устройстве",
    },
    {
        id: "security",
        label: "Безопасность",
        hash: "sign-in-security",
        description: "Вход, пароли приложений и ключи API",
    },
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

/** Shows a mobile settings overview and desktop tabs, retaining visited drafts. */
export function UserSettingsLayout({
    sections,
    saveDock,
}: UserSettingsLayoutProps) {
    const [section, setSection] = useState<UserSettingsTab | null>(null);
    const [visited, setVisited] = useState<ReadonlySet<UserSettingsTab>>(
        () => new Set(["profile"]),
    );
    const tabList = useRef<HTMLDivElement>(null);
    const heading = useRef<HTMLHeadingElement>(null);
    const focusHeading = useRef<"reset-scroll" | "keep-scroll" | null>(null);
    const active = section ?? "profile";
    const activeTab = tabs.find((tab) => tab.id === section);

    const activate = useCallback((id: UserSettingsTab | null) => {
        setSection(id);
        if (!id) return;
        setVisited((previous) =>
            previous.has(id) ? previous : new Set([...previous, id]),
        );
    }, []);

    useEffect(() => {
        const readLocation = (moveFocus: boolean) => {
            const url = new URL(window.location.href);
            // The sign-in callback can arrive without the security fragment.
            if (
                !url.hash &&
                (url.searchParams.has("ssoLinked") ||
                    url.searchParams.has("ssoError"))
            ) {
                url.hash = "sign-in-security";
                window.history.replaceState(window.history.state, "", url);
            }
            let hash: string;
            try {
                hash = decodeURIComponent(url.hash.slice(1));
            } catch {
                return;
            }
            const target = Object.hasOwn(legacySections, hash)
                ? legacySections[hash]
                : null;
            focusHeading.current = null;
            if (moveFocus && (!hash || target)) {
                const pointsToSubsection =
                    hash && !tabs.some((tab) => tab.hash === hash);
                focusHeading.current = pointsToSubsection
                    ? "keep-scroll"
                    : "reset-scroll";
            }
            activate(target);
        };
        const restore = () => readLocation(true);
        readLocation(false);
        window.addEventListener("popstate", restore);
        window.addEventListener("hashchange", restore);
        return () => {
            window.removeEventListener("popstate", restore);
            window.removeEventListener("hashchange", restore);
        };
    }, [activate]);

    useEffect(() => {
        const focus = focusHeading.current;
        focusHeading.current = null;
        if (!focus || window.matchMedia("(min-width: 640px)").matches) return;
        // Native fragment traversal can clear focus after popstate.
        const frame = window.requestAnimationFrame(() => {
            if (focus === "reset-scroll") {
                heading.current
                    ?.closest("main")
                    ?.scrollTo({ top: 0, behavior: "instant" });
            }
            heading.current?.focus({ preventScroll: true });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [section]);

    const navigate = (id: UserSettingsTab | null) => {
        focusHeading.current = "reset-scroll";
        activate(id);
        const tab = tabs.find((item) => item.id === id);
        const url = new URL(window.location.href);
        const hash = tab ? `#${tab.hash}` : "";
        if (url.hash !== hash) {
            url.hash = hash;
            window.history.pushState({}, "", url);
        }
    };

    const followLink = (
        event: MouseEvent<HTMLAnchorElement>,
        id: UserSettingsTab | null,
    ) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return;
        event.preventDefault();
        navigate(id);
    };

    return (
        <div className="settings-page min-h-full">
            <div className="mx-auto max-w-4xl px-4 py-6 sm:px-8 md:py-10">
                <header className="mb-6">
                    {activeTab && (
                        <a
                            href="/settings"
                            onClick={(event) => followLink(event, null)}
                            className="mb-2 inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-semibold text-content-secondary hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand sm:hidden"
                        >
                            <ArrowLeft aria-hidden="true" className="size-4" />
                            Все настройки
                        </a>
                    )}
                    <h1
                        ref={heading}
                        tabIndex={-1}
                        className="font-display text-3xl font-bold tracking-tight text-content focus:outline-none md:text-4xl"
                    >
                        <span className="sm:hidden">
                            {activeTab?.label ?? ru.settings.title}
                        </span>
                        <span className="hidden sm:inline">
                            {ru.settings.title}
                        </span>
                    </h1>
                    <p
                        className={`mt-2 text-sm leading-6 text-content-muted ${activeTab ? "hidden sm:block" : ""}`}
                    >
                        Ваш профиль, звучание и музыка на этом устройстве.
                    </p>
                </header>
                {!section && (
                    <nav
                        aria-label={ru.settings.sectionsAria}
                        className="sm:hidden"
                    >
                        <ul className="divide-y divide-line rounded-2xl border border-line bg-surface-raised">
                            {tabs.map((tab) => (
                                <li key={tab.id}>
                                    <a
                                        href={`#${tab.hash}`}
                                        onClick={(event) =>
                                            followLink(event, tab.id)
                                        }
                                        className="group flex min-h-11 items-center gap-3 rounded-xl px-4 py-3 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                                    >
                                        <span className="min-w-0 flex-1">
                                            <span className="block font-semibold text-content">
                                                {tab.label}
                                            </span>
                                            <span className="mt-0.5 block text-sm leading-5 text-content-muted">
                                                {tab.description}
                                            </span>
                                        </span>
                                        <ChevronRight
                                            aria-hidden="true"
                                            className="size-4 shrink-0 text-content-muted motion-safe:transition-transform motion-safe:duration-180 motion-safe:group-active:translate-x-0.5"
                                        />
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </nav>
                )}
                <div className="mb-6 hidden rounded-2xl border border-line bg-surface-raised p-2 sm:block">
                    <div
                        ref={tabList}
                        role="tablist"
                        aria-label={ru.settings.sectionsAria}
                        className="flex gap-1"
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
                        className={`min-w-0 space-y-4 md:space-y-5 ${!section && active === tab.id ? "hidden sm:block" : ""}`}
                    >
                        {visited.has(tab.id) ? sections[tab.id] : null}
                    </div>
                ))}
                {saveDock}
            </div>
        </div>
    );
}
