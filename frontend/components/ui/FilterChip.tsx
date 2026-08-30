import Link from "next/link";
import type { MouseEventHandler, ReactNode } from "react";
import { cn } from "@/utils/cn";

interface FilterChipProps {
    active: boolean;
    children: ReactNode;
    className?: string;
    href?: string;
    onClick?: MouseEventHandler<HTMLButtonElement>;
    tabIndex?: number;
    "data-tv-card"?: boolean;
    "data-tv-card-index"?: number;
}

/**
 * Renders the canonical compact filter control used by music result views.
 */
export function FilterChip({
    active,
    children,
    className,
    href,
    onClick,
    tabIndex,
    "data-tv-card": dataTvCard,
    "data-tv-card-index": dataTvCardIndex,
}: FilterChipProps) {
    const sharedProps = {
        "data-state": active ? "active" : "inactive",
        "data-tv-card": dataTvCard,
        "data-tv-card-index": dataTvCardIndex,
        className: cn("music-filter-chip", className),
        tabIndex,
    } as const;

    if (href) {
        return (
            <Link
                {...sharedProps}
                href={href}
                aria-current={active ? "page" : undefined}
            >
                {children}
            </Link>
        );
    }

    return (
        <button
            {...sharedProps}
            type="button"
            aria-pressed={active}
            onClick={onClick}
        >
            {children}
        </button>
    );
}
