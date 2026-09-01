import { ChevronDown } from "lucide-react";
import { SETTINGS_FIELD_FOCUS_RING } from "./settingsFieldStyles";

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
}: SettingsSelectProps) {
    return (
        <div className="relative">
            <select
                id={id}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                className={`
                    appearance-none bg-surface-elevated text-content text-base sm:text-sm
                    min-h-11 pl-3.5 pr-10 py-2.5 rounded-xl
                    border border-line outline-none
                    ${SETTINGS_FIELD_FOCUS_RING}
                    cursor-pointer transition-colors
                    hover:border-line-muted hover:bg-surface-highlight
                    ${disabled ? "opacity-50 cursor-not-allowed" : ""}
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
