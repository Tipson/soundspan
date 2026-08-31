"use client";

import { useContext } from "react";
import { SettingsFieldContext } from "./settingsFieldContext";

interface SettingsToggleProps {
    id?: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
}

/**
 * Renders the SettingsToggle component.
 */
export function SettingsToggle({
    id,
    checked,
    onChange,
    disabled,
}: SettingsToggleProps) {
    const rowContext = useContext(SettingsFieldContext);

    return (
        <label className="relative inline-flex min-h-11 min-w-11 items-center justify-center cursor-pointer">
            <input
                id={id}
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                disabled={disabled}
                aria-labelledby={rowContext?.labelId}
                className="sr-only peer"
            />
            <div
                className={`
                relative w-10 h-6 rounded-full transition-colors
                ${disabled ? "opacity-50 cursor-not-allowed" : ""}
                ${checked ? "bg-brand" : "bg-line-muted"}
                peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-brand-hover
                after:content-[''] after:absolute after:top-[2px] after:left-[2px]
                after:bg-white after:rounded-full after:h-5 after:w-5
                after:transition-transform after:duration-200
                ${checked ? "after:translate-x-4" : "after:translate-x-0"}
            `}
            />
        </label>
    );
}
