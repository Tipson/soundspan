import { InputHTMLAttributes, ReactNode, useId } from "react";
import { cn } from "@/utils/cn";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    error?: string;
    rightIcon?: ReactNode;
}

/**
 * Renders the Input component.
 */
export function Input({
    label,
    error,
    rightIcon,
    className,
    id,
    "aria-describedby": describedBy,
    "aria-invalid": invalid,
    ...props
}: InputProps) {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const errorId = `${inputId}-error`;
    const descriptionIds =
        [describedBy, error ? errorId : undefined].filter(Boolean).join(" ") ||
        undefined;
    return (
        <div className="w-full">
            {label && (
                <label
                    htmlFor={inputId}
                    className="mb-2 block text-sm font-medium text-content"
                >
                    {label}
                </label>
            )}
            <div className="relative">
                <input
                    id={inputId}
                    aria-invalid={error ? true : invalid}
                    aria-describedby={descriptionIds}
                    className={cn(
                        "min-h-11 w-full rounded-[var(--music-radius-control)] border border-line bg-surface-raised px-3.5 py-2.5 text-base text-content",
                        "placeholder:text-content-muted",
                        "focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20",
                        "transition-[border-color,background-color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-50",
                        error &&
                            "border-error/60 focus:border-error focus:ring-error/20",
                        rightIcon && "pr-12",
                        className,
                    )}
                    {...props}
                />
                {rightIcon && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 text-content-muted">
                        {rightIcon}
                    </div>
                )}
            </div>
            {error && (
                <p id={errorId} className="mt-2 text-sm text-error">
                    {error}
                </p>
            )}
        </div>
    );
}
