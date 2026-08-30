"use client";

import { useContext, useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { SETTINGS_FIELD_FOCUS_RING } from "./settingsFieldStyles";
import { SettingsFieldContext } from "./settingsFieldContext";

interface SettingsInputProps {
    id?: string;
    type?: "text" | "password" | "url" | "number" | "email";
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    name?: string;
    autoComplete?: string;
    "aria-label"?: string;
}

function normalizeFieldName(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

/**
 * Renders the SettingsInput component.
 */
export function SettingsInput({
    id,
    type = "text",
    value,
    onChange,
    placeholder,
    disabled,
    className = "",
    name,
    autoComplete,
    "aria-label": ariaLabel,
}: SettingsInputProps) {
    const [showPassword, setShowPassword] = useState(false);
    const rowContext = useContext(SettingsFieldContext);
    const generatedId = useId().replaceAll(":", "");
    const isPassword = type === "password";
    const resolvedId = id ?? `settings-input-${generatedId}`;
    const resolvedName =
        name ??
        id ??
        rowContext?.fieldName ??
        (placeholder
            ? normalizeFieldName(placeholder)
            : `settings-input-${generatedId}`);
    const resolvedAutoComplete =
        autoComplete ?? (type === "email" ? "email" : "off");
    const fallbackAriaLabel =
        !rowContext?.labelId && !ariaLabel
            ? placeholder || resolvedName.replaceAll("-", " ")
            : undefined;

    return (
        <div className={`relative ${className}`}>
            <input
                id={resolvedId}
                name={resolvedName || `settings-input-${generatedId}`}
                autoComplete={resolvedAutoComplete}
                aria-labelledby={ariaLabel ? undefined : rowContext?.labelId}
                aria-label={ariaLabel ?? fallbackAriaLabel}
                type={isPassword && showPassword ? "text" : type}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                disabled={disabled}
                className={`
                    min-h-11 w-full bg-surface-elevated text-content text-sm
                    px-3.5 py-2.5 rounded-xl
                    border border-line outline-none
                    ${SETTINGS_FIELD_FOCUS_RING}
                    placeholder:text-content-muted
                    transition-colors
                    hover:border-line-muted hover:bg-surface-highlight focus:border-brand/60 focus:bg-surface-highlight
                    ${isPassword ? "pr-10" : ""}
                    ${disabled ? "opacity-50 cursor-not-allowed" : ""}
                `}
            />
            {isPassword && (
                <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={
                        showPassword ? "Скрыть пароль" : "Показать пароль"
                    }
                    className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-content-muted transition-colors hover:bg-white/[0.06] hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-hover"
                >
                    {showPassword ? (
                        <EyeOff className="w-4 h-4" />
                    ) : (
                        <Eye className="w-4 h-4" />
                    )}
                </button>
            )}
        </div>
    );
}
