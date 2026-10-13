"use client";

import { useContext, useId } from "react";
import { ChevronDown } from "lucide-react";
import { SETTINGS_FIELD_FOCUS_RING } from "./settingsFieldStyles";
import { SettingsFieldContext } from "./settingsFieldContext";

interface Option {
    value: string;
    label: string;
    description?: string;
}

interface SettingsSelectProps {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    options: Option[];
    disabled?: boolean;
    wrapValue?: boolean;
    "aria-label"?: string;
}

/**
 * Renders the SettingsSelect component.
 */
export function SettingsSelect({
    id,
    value,
    onChange,
    options,
    disabled,
    wrapValue = false,
    "aria-label": ariaLabel,
}: SettingsSelectProps) {
    const rowContext = useContext(SettingsFieldContext);
    const generatedId = useId().replaceAll(":", "");

    return (
        <div className={`relative min-w-0 ${wrapValue ? "grid" : ""}`}>
            {wrapValue && (
                <span
                    aria-hidden="true"
                    className={`pointer-events-none relative z-10 col-start-1 row-start-1 min-h-11 py-2.5 pl-3.5 pr-10 text-base leading-6 text-content sm:text-sm sm:leading-5 ${disabled ? "opacity-50" : ""}`}
                >
                    {options.find((option) => option.value === value)?.label}
                </span>
            )}
            <select
                id={id ?? `settings-select-${generatedId}`}
                aria-labelledby={ariaLabel ? undefined : rowContext?.labelId}
                aria-label={ariaLabel}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                className={`
                    appearance-none bg-surface-elevated text-content text-base sm:text-sm
                    min-h-11 w-full pl-3.5 pr-10 py-2.5 rounded-[10px]
                    border border-line outline-none
                    ${SETTINGS_FIELD_FOCUS_RING}
                    cursor-pointer transition-colors motion-reduce:transition-none
                    hover:border-line-muted hover:bg-surface-highlight
                    ${disabled ? "opacity-50 cursor-not-allowed" : ""}
                    ${wrapValue ? "col-start-1 row-start-1 text-transparent [color:transparent] [&_option]:text-content" : ""}
                `}
            >
                {options.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-muted" />
        </div>
    );
}
