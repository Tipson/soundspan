import { HTMLAttributes, forwardRef, memo } from "react";
import { cn } from "@/utils/cn";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
    variant?: "default" | "ai" | "metric";
    hover?: boolean;
}

const Card = memo(
    forwardRef<HTMLDivElement, CardProps>(
        (
            {
                className,
                variant = "default",
                hover = true,
                children,
                ...props
            },
            ref,
        ) => {
            const baseStyles =
                "rounded-[var(--music-radius-card)] p-4 transition-[background-color,border-color,transform] duration-150 ease-out";

            const variantStyles = {
                default: cn(
                    "bg-transparent",
                    hover && "hover:bg-surface-elevated/70",
                ),
                ai: cn(
                    "bg-surface-raised",
                    hover && "hover:bg-surface-elevated",
                ),
                metric: "bg-surface-raised",
            };

            return (
                <div
                    ref={ref}
                    className={cn(
                        baseStyles,
                        variantStyles[variant],
                        className,
                    )}
                    {...props}
                >
                    {children}
                </div>
            );
        },
    ),
);

Card.displayName = "Card";

export { Card };
