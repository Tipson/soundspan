import Link from "next/link";

interface SearchSectionHeaderProps {
    title: string;
    showAllHref?: string;
    status?: React.ReactNode;
}

/** Label a search result section and expose its dedicated view when relevant. */
export function SearchSectionHeader({
    title,
    showAllHref,
    status,
}: SearchSectionHeaderProps) {
    return (
        <div className="mb-4 flex min-h-11 items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
                <h2 className="text-xl font-black tracking-[-0.025em] text-content sm:text-2xl">
                    {title}
                </h2>
                {status}
            </div>
            {showAllHref ? (
                <Link
                    href={showAllHref}
                    className="inline-flex min-h-10 shrink-0 items-center rounded-full px-3 text-sm font-semibold text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                >
                    Show all
                </Link>
            ) : null}
        </div>
    );
}
