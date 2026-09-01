interface SearchSectionHeaderProps {
    title: string;
    description?: string;
    status?: React.ReactNode;
}

/** Label a result section without hiding primary content behind another route. */
export function SearchSectionHeader({
    title,
    description,
    status,
}: SearchSectionHeaderProps) {
    return (
        <div className="mb-4 flex min-h-11 flex-wrap items-end justify-between gap-x-4 gap-y-2 sm:mb-5">
            <div className="min-w-0">
                <h2 className="text-xl font-black tracking-[-0.025em] text-content sm:text-2xl">
                    {title}
                </h2>
                {description ? (
                    <p className="mt-1 text-sm text-content-secondary">
                        {description}
                    </p>
                ) : null}
            </div>
            {status}
        </div>
    );
}
