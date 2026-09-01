import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

interface PageHeaderProps {
    title: string;
    subtitle: string;
    icon: LucideIcon;
    iconClassName?: string;
    titleClassName?: string;
    subtitleClassName?: string;
    className?: string;
    badge?: ReactNode;
    actions?: ReactNode;
}

/**
 * Renders the PageHeader component.
 */
export function PageHeader({
    title,
    subtitle,
    icon: Icon,
    iconClassName,
    titleClassName,
    subtitleClassName,
    className,
    badge,
    actions,
}: PageHeaderProps) {
    return (
        <div data-page-header="editorial" className={cn("mb-8", className)}>
            <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0">
                    <div className="mb-2 flex items-center gap-3">
                        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
                            <Icon
                                className={cn("size-6", iconClassName)}
                                aria-hidden="true"
                            />
                        </span>
                        <div className="flex min-w-0 flex-wrap items-center gap-3">
                            <h1
                                className={cn(
                                    "text-balance text-[clamp(2rem,5vw,3.5rem)] font-bold tracking-[-0.035em] text-content",
                                    titleClassName,
                                )}
                            >
                                {title}
                            </h1>
                            {badge}
                        </div>
                    </div>
                    <p
                        className={cn(
                            "max-w-2xl text-sm leading-6 text-content-muted sm:text-base",
                            subtitleClassName,
                        )}
                    >
                        {subtitle}
                    </p>
                </div>
                {actions ? (
                    <div className="flex w-full items-center gap-2 overflow-x-auto pb-1 sm:w-auto sm:justify-end sm:pb-0">
                        {actions}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
