"use client";

import { ReactNode, memo } from "react";
import { Button } from "./Button";

export interface EmptyStateProps {
    icon: ReactNode;
    title: string;
    description: string;
    children?: ReactNode;
    action?: {
        label: string;
        onClick: () => void;
        variant?: "primary" | "secondary" | "ghost";
    };
}

const EmptyState = memo(function EmptyState({
    icon,
    title,
    description,
    children,
    action,
}: EmptyStateProps) {
    return (
        <div className="flex flex-col items-center justify-center px-4 py-12 text-center md:py-16">
            <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-surface-elevated text-brand">
                {icon}
            </div>
            <h3 className="mb-2 text-lg font-semibold text-content md:text-xl">
                {title}
            </h3>
            <p className="mb-6 max-w-md text-sm leading-6 text-content-muted md:text-base">
                {description}
            </p>
            {children}
            {action && (
                <Button
                    variant={action.variant || "primary"}
                    onClick={action.onClick}
                >
                    {action.label}
                </Button>
            )}
        </div>
    );
});

export { EmptyState };
