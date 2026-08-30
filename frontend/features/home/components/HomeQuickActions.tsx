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
        <section aria-label="Your shortcuts">
            <h2 id="home-quick-access-title" className="sr-only">
                Your shortcuts
            </h2>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                {HOME_QUICK_ACTIONS.map((action) => {
                    const ActionIcon = action.icon;
                    return (
                        <Link
                            key={action.href}
                            href={action.href}
                            className="group flex min-h-[4.25rem] items-center gap-2.5 rounded-2xl bg-white/[0.04] px-2.5 py-2 text-left transition duration-200 active:scale-[0.99] hover:bg-white/[0.075] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none sm:gap-3 sm:px-3"
                        >
                            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand-light transition-colors duration-200 group-hover:bg-brand/20 group-hover:text-content motion-reduce:transition-none">
                                <ActionIcon
                                    className="h-5 w-5"
                                    aria-hidden="true"
                                    strokeWidth={1.9}
                                />
                            </span>
                            <span className="min-w-0">
                                <span className="block text-[0.8125rem] font-bold leading-tight text-content sm:text-sm">
                                    {action.label}
                                </span>
                                <span className="mt-0.5 hidden truncate text-xs leading-5 text-content-muted xl:block">
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
