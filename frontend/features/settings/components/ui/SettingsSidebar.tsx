"use client";

import { ru } from "@/lib/i18n/ru";

/** One deep-linkable Settings section and its first-level navigation group. */
export interface SidebarItem {
    id: string;
    label: string;
    groupId?: string;
    groupLabel?: string;
    adminOnly?: boolean;
}

interface SettingsSidebarProps {
    items: SidebarItem[];
    activeSection: string;
    onSectionClick: (id: string) => void;
    isAdmin: boolean;
}

interface SettingsGroup {
    id: string;
    label: string;
    items: SidebarItem[];
}

function buildGroups(items: SidebarItem[]): SettingsGroup[] {
    const groups: SettingsGroup[] = [];
    for (const item of items) {
        const groupId = item.groupId ?? "general";
        const existing = groups.find((group) => group.id === groupId);
        if (existing) {
            existing.items.push(item);
            continue;
        }
        groups.push({
            id: groupId,
            label: item.groupLabel ?? "Основные",
            items: [item],
        });
    }
    return groups;
}

const navigationButtonClassName =
    "inline-flex min-h-11 min-w-max touch-manipulation items-center justify-center rounded-xl px-3.5 py-2 text-sm font-semibold transition-[transform,background-color,color] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none";

/** Renders a two-level group and section navigator for Settings. */
export function SettingsSidebar({
    items,
    activeSection,
    onSectionClick,
    isAdmin,
}: SettingsSidebarProps) {
    const visibleItems = items.filter((item) => !item.adminOnly || isAdmin);
    const groups = buildGroups(visibleItems);
    const activeItem =
        visibleItems.find((item) => item.id === activeSection) ??
        visibleItems[0];
    const activeGroupId = activeItem?.groupId ?? "general";
    const activeGroup =
        groups.find((group) => group.id === activeGroupId) ?? groups[0];

    return (
        <div className="sticky top-0 z-20 -mx-4 mb-5 border-y border-line bg-surface/92 px-4 py-2.5 backdrop-blur-xl md:mx-0 md:mb-7 md:rounded-2xl md:border md:px-3">
            <nav
                data-settings-navigation-level="groups"
                aria-label="Группы настроек"
            >
                <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
                    {groups.map((group) => {
                        const active = group.id === activeGroup?.id;
                        return (
                            <button
                                key={group.id}
                                type="button"
                                onClick={() =>
                                    group.items[0] &&
                                    onSectionClick(group.items[0].id)
                                }
                                aria-current={active ? "page" : undefined}
                                className={`${navigationButtonClassName} ${
                                    active
                                        ? "bg-brand text-black"
                                        : "text-content-secondary hover:bg-white/[0.06] hover:text-content"
                                }`}
                            >
                                {group.label}
                            </button>
                        );
                    })}
                </div>
            </nav>

            <nav
                data-settings-navigation-level="sections"
                aria-label={ru.settings.sectionsAria}
                className="mt-1 border-t border-line pt-1"
            >
                <div className="flex gap-1 overflow-x-auto scrollbar-hide">
                    {activeGroup?.items.map((item) => {
                        const active = activeSection === item.id;
                        return (
                            <button
                                key={item.id}
                                type="button"
                                onClick={() => onSectionClick(item.id)}
                                aria-current={active ? "location" : undefined}
                                data-state={active ? "active" : "inactive"}
                                className={`${navigationButtonClassName} ${
                                    active
                                        ? "bg-white/[0.08] text-content"
                                        : "text-content-muted hover:bg-white/[0.05] hover:text-content-secondary"
                                }`}
                            >
                                {item.label}
                            </button>
                        );
                    })}
                </div>
            </nav>
        </div>
    );
}
