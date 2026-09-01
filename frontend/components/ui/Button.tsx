import { ButtonHTMLAttributes, forwardRef, memo } from "react";
import { cn } from "@/utils/cn";
import { GradientSpinner } from "./GradientSpinner";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: "primary" | "secondary" | "ghost" | "danger" | "ai" | "icon";
    isLoading?: boolean;
}

const Button = memo(
    forwardRef<HTMLButtonElement, ButtonProps>(
        (
            {
                className,
                variant = "secondary",
                isLoading,
                children,
                disabled,
                ...props
            },
            ref,
        ) => {
            const baseStyles =
                "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl font-semibold transition-[color,background-color,border-color,box-shadow,transform] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-hover focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-45 enabled:active:scale-[0.98]";

            const variantStyles = {
                primary:
                    "bg-brand px-5 py-2.5 text-surface shadow-lg shadow-brand/10 hover:bg-brand-hover",
                secondary:
                    "border border-line bg-surface-elevated px-5 py-2.5 text-content hover:border-line-muted hover:bg-surface-hover",
                ghost: "px-4 py-2.5 text-content-muted hover:bg-surface-hover hover:text-content",
                danger: "border border-error/25 px-5 py-2.5 text-error hover:border-error/45 hover:bg-error/10",
                ai: "border border-ai/25 bg-ai/10 px-5 py-2.5 text-ai-hover hover:border-ai/45 hover:bg-ai/15",
                icon: "size-11 shrink-0 p-0 text-content-muted hover:bg-surface-hover hover:text-content",
            };

            return (
                <button
                    ref={ref}
                    className={cn(
                        baseStyles,
                        variantStyles[variant],
                        className,
                    )}
                    disabled={disabled || isLoading}
                    {...props}
                >
                    {isLoading ? (
                        <>
                            <GradientSpinner size="sm" className="mr-2" />
                            {children}
                        </>
                    ) : (
                        children
                    )}
                </button>
            );
        },
    ),
);

Button.displayName = "Button";

export { Button };
