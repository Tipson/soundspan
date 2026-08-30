"use client";

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { SettingsSidebar, SidebarItem } from "./SettingsSidebar";
import { ru } from "@/lib/i18n/ru";

interface SettingsLayoutProps {
    children: ReactNode;
    sidebarItems: SidebarItem[];
    isAdmin: boolean;
    title?: string;
}

/**
 * Renders the SettingsLayout component.
 */
export function SettingsLayout({
    children,
    sidebarItems,
    isAdmin,
    title = ru.settings.title,
}: SettingsLayoutProps) {
    const [activeSection, setActiveSection] = useState(
        sidebarItems[0]?.id || "",
    );
    const mainContentRef = useRef<HTMLDivElement>(null);

    const scrollToSection = useCallback((id: string): boolean => {
        const element = document.getElementById(id);
        if (element) {
            const reduceMotion = window.matchMedia?.(
                "(prefers-reduced-motion: reduce)",
            ).matches;
            element.scrollIntoView({
                behavior: reduceMotion ? "auto" : "smooth",
                block: "start",
            });
            setActiveSection(id);
            return true;
        }
        return false;
    }, []);

    // Handle sidebar click - scroll to section and keep it deep-linkable.
    const handleSectionClick = useCallback(
        (id: string) => {
            if (!scrollToSection(id)) return;

            const url = new URL(window.location.href);
            if (url.hash !== `#${id}`) {
                url.hash = id;
                window.history.pushState({}, "", url);
            }
        },
        [scrollToSection],
    );

    useEffect(() => {
        const visibleSectionIds = new Set(
            sidebarItems
                .filter((item) => !item.adminOnly || isAdmin)
                .map((item) => item.id),
        );
        let retryTimer: ReturnType<typeof setTimeout> | undefined;

        const restoreSectionFromLocation = () => {
            const hash = window.location.hash.slice(1);
            if (!hash) return;

            let id: string;
            try {
                id = decodeURIComponent(hash);
            } catch {
                return;
            }
            if (!visibleSectionIds.has(id)) return;

            if (!scrollToSection(id)) {
                retryTimer = setTimeout(() => scrollToSection(id), 150);
            }
        };

        restoreSectionFromLocation();
        window.addEventListener("popstate", restoreSectionFromLocation);
        window.addEventListener("hashchange", restoreSectionFromLocation);

        return () => {
            if (retryTimer) clearTimeout(retryTimer);
            window.removeEventListener("popstate", restoreSectionFromLocation);
            window.removeEventListener(
                "hashchange",
                restoreSectionFromLocation,
            );
        };
    }, [sidebarItems, isAdmin, scrollToSection]);

    // Track active section based on scroll position
    useEffect(() => {
        const visibleItems = sidebarItems.filter(
            (item) => !item.adminOnly || isAdmin,
        );

        // Find the scrollable parent (the main element in AuthenticatedLayout)
        const findScrollableParent = (
            el: HTMLElement | null,
        ): HTMLElement | null => {
            while (el) {
                const style = window.getComputedStyle(el);
                if (
                    style.overflowY === "auto" ||
                    style.overflowY === "scroll"
                ) {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        };

        const scrollContainer = mainContentRef.current
            ? findScrollableParent(mainContentRef.current)
            : null;

        if (!scrollContainer) return;

        // Use scroll event for smooth tracking
        const handleScroll = () => {
            const containerRect = scrollContainer.getBoundingClientRect();
            const offset = 150; // Offset from top

            // Find the section that's currently in view
            let currentSection = visibleItems[0]?.id || "";

            for (const item of visibleItems) {
                const element = document.getElementById(item.id);
                if (element) {
                    const rect = element.getBoundingClientRect();
                    // Check if element top is above the offset line
                    if (rect.top <= containerRect.top + offset) {
                        currentSection = item.id;
                    }
                }
            }

            setActiveSection((prev) => {
                if (prev !== currentSection) {
                    return currentSection;
                }
                return prev;
            });
        };

        // Throttle scroll events
        let ticking = false;
        const scrollHandler = () => {
            if (!ticking) {
                requestAnimationFrame(() => {
                    handleScroll();
                    ticking = false;
                });
                ticking = true;
            }
        };

        scrollContainer.addEventListener("scroll", scrollHandler, {
            passive: true,
        });

        // Initial check
        handleScroll();

        return () =>
            scrollContainer.removeEventListener("scroll", scrollHandler);
    }, [sidebarItems, isAdmin]);

    return (
        <div className="settings-page min-h-full">
            <div className="relative mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-10 xl:px-10">
                <header className="mb-7 max-w-2xl md:mb-10">
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-light">
                        {ru.settings.eyebrow}
                    </p>
                    <h1 className="text-3xl font-bold tracking-[-0.04em] text-content md:text-4xl">
                        {title}
                    </h1>
                    <p className="mt-3 text-sm leading-6 text-content-secondary md:text-base">
                        {ru.settings.description}
                    </p>
                </header>

                <div className="grid items-start gap-5 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8">
                    <SettingsSidebar
                        items={sidebarItems}
                        activeSection={activeSection}
                        onSectionClick={handleSectionClick}
                        isAdmin={isAdmin}
                    />

                    <div
                        ref={mainContentRef}
                        className="min-w-0 space-y-4 md:space-y-5"
                    >
                        {children}
                    </div>
                </div>
            </div>
        </div>
    );
}
