import Link from "next/link";
import {
    ArrowDownToLine,
    Clock3,
    Heart,
    Search,
    type LucideIcon,
} from "lucide-react";

interface HomeQuickAction {
    href: string;
    label: string;
    description: string;
    icon: LucideIcon;
}

const HOME_QUICK_ACTIONS: readonly HomeQuickAction[] = [
    {
        href: "/playlist/my-liked",
        label: "Liked songs",
        description: "Everything you saved",
        icon: Heart,
    },
    {
        href: "/my-history",
        label: "Listening history",
        description: "Pick up where you left off",
        icon: Clock3,
    },
    {
        href: "/import",
        label: "Import playlists",
        description: "Bring over a Spotify playlist",
        icon: ArrowDownToLine,
    },
    {
        href: "/search",
        label: "Search music",
        description: "Tracks, albums, and artists",
        icon: Search,
    },
];

/** Direct links to the user's most common music actions. */
export function HomeQuickActions() {
    return (
        <section aria-labelledby="home-quick-access-title">
            <h2
                id="home-quick-access-title"
                className="mb-3 text-sm font-bold uppercase tracking-[0.16em] text-content-secondary"
            >
                Quick access
            </h2>
            <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
                {HOME_QUICK_ACTIONS.map((action) => {
                    const ActionIcon = action.icon;
                    return (
                        <Link
                            key={action.href}
                            href={action.href}
                            className="group flex min-h-24 items-center gap-3 rounded-2xl border border-white/8 bg-surface-raised px-3 py-3 text-left transition duration-200 hover:border-brand/30 hover:bg-surface-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none sm:min-h-28 sm:px-4"
                        >
                            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/[0.055] text-brand-light transition-colors duration-200 group-hover:bg-brand/15 group-hover:text-white motion-reduce:transition-none">
                                <ActionIcon
                                    className="h-5 w-5"
                                    aria-hidden="true"
                                    strokeWidth={1.9}
                                />
                            </span>
                            <span className="min-w-0">
                                <span className="block text-sm font-bold leading-tight text-content sm:text-base">
                                    {action.label}
                                </span>
                                <span className="mt-1 hidden text-xs leading-5 text-content-muted sm:block">
                                    {action.description}
                                </span>
                            </span>
                        </Link>
                    );
                })}
            </div>
        </section>
    );
}
