import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { memo } from "react";

interface SectionHeaderProps {
    title: string;
    showAllHref?: string;
    rightAction?: React.ReactNode;
    badge?: React.ReactNode;
}

const SectionHeader = memo(function SectionHeader({
    title,
    showAllHref,
    rightAction,
    badge,
}: SectionHeaderProps) {
    return (
        <div className="mb-4 flex min-h-11 items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
                <h2 className="truncate text-xl font-black tracking-[-0.025em] text-content sm:text-2xl">
                    {title}
                </h2>
                {badge && <Badge variant="ai">{badge}</Badge>}
            </div>
            {rightAction ? (
                rightAction
            ) : showAllHref ? (
                <Link
                    href={showAllHref}
                    className="group inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full px-2 text-sm font-semibold text-content-muted transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                >
                    Показать все
                    <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
                </Link>
            ) : null}
        </div>
    );
});

export { SectionHeader };
