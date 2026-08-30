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
        <div className="mb-6 flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
                <h2 className="text-2xl font-bold text-white">{title}</h2>
                {status}
            </div>
            {showAllHref ? (
                <Link
                    href={showAllHref}
                    className="shrink-0 text-sm font-semibold text-content-secondary transition-colors hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                    Show all
                </Link>
            ) : null}
        </div>
    );
}
