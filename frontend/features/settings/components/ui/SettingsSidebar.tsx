"use client";

export interface SidebarItem {
    id: string;
    label: string;
    adminOnly?: boolean;
}

interface SettingsSidebarProps {
    items: SidebarItem[];
    activeSection: string;
    onSectionClick: (id: string) => void;
    isAdmin: boolean;
}

/**
 * Renders the SettingsSidebar component.
 */
export function SettingsSidebar({
    items,
    activeSection,
    onSectionClick,
    isAdmin,
}: SettingsSidebarProps) {
    const filteredItems = items.filter((item) => !item.adminOnly || isAdmin);

    // Group items: regular items first, then admin-only items
    const regularItems = filteredItems.filter((item) => !item.adminOnly);
    const adminItems = filteredItems.filter((item) => item.adminOnly);

    return (
        <nav
            className="settings-section-navigation min-w-0 self-start lg:sticky lg:top-6 lg:w-56 lg:shrink-0"
            aria-label="Settings sections"
        >
            <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide lg:flex-col lg:gap-1 lg:overflow-visible lg:pb-0">
                {regularItems.map((item) => (
                    <button
                        key={item.id}
                        onClick={() => onSectionClick(item.id)}
                        aria-current={
                            activeSection === item.id ? "location" : undefined
                        }
                        className="settings-navigation-item"
                        data-state={
                            activeSection === item.id ? "active" : "inactive"
                        }
                    >
                        {item.label}
                    </button>
                ))}

                {adminItems.length > 0 && (
                    <>
                        <div className="hidden px-3 pb-2 pt-5 lg:block">
                            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-content-muted">
                                Admin
                            </span>
                        </div>
                        {adminItems.map((item) => (
                            <button
                                key={item.id}
                                onClick={() => onSectionClick(item.id)}
                                aria-current={
                                    activeSection === item.id
                                        ? "location"
                                        : undefined
                                }
                                className="settings-navigation-item"
                                data-state={
                                    activeSection === item.id
                                        ? "active"
                                        : "inactive"
                                }
                            >
                                {item.label}
                            </button>
                        ))}
                    </>
                )}
            </div>
        </nav>
    );
}
