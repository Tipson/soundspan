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
                "rounded-2xl p-4 transition-[background-color,border-color,transform] duration-200 ease-out";

            const variantStyles = {
                default: cn(
                    "bg-transparent",
                    hover && "hover:bg-surface-elevated/70",
                ),
                ai: cn(
                    "border border-ai/20 bg-gradient-to-br from-ai/8 to-surface-raised",
                    hover && "hover:border-ai/40",
                ),
                metric: "border border-line bg-surface-raised",
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
