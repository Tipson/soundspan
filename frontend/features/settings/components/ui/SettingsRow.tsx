"use client";

import { ReactNode, useId } from "react";
import { SettingsFieldContext } from "./settingsFieldContext";

interface SettingsRowProps {
    label: ReactNode;
    description?: ReactNode;
    children: ReactNode;
    htmlFor?: string;
    labelExtra?: ReactNode;
    align?: "center" | "start";
}

/**
 * Renders the SettingsRow component.
 */
export function SettingsRow({
    label,
    description,
    children,
    htmlFor,
    labelExtra,
    align = "center",
}: SettingsRowProps) {
    const generatedId = useId().replaceAll(":", "");
    const labelId = `settings-field-${generatedId}-label`;
    const fieldName =
        typeof label === "string"
            ? label
                  .trim()
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-|-$/g, "") || undefined
            : undefined;
    const labelClassName = "text-sm font-medium text-content";

    return (
        <SettingsFieldContext.Provider value={{ labelId, fieldName }}>
            <div
                className={`settings-row flex min-h-16 flex-col items-start justify-between gap-3 py-4 sm:flex-row sm:gap-6 ${
                    align === "start" ? "sm:items-start" : "sm:items-center"
                }`}
            >
                <div className="min-w-0 flex-1 sm:pr-4">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        {htmlFor ? (
                            <label
                                id={labelId}
                                htmlFor={htmlFor}
                                className={`cursor-pointer ${labelClassName}`}
                            >
                                {label}
                            </label>
                        ) : (
                            <span id={labelId} className={labelClassName}>
                                {label}
                            </span>
                        )}
                        {labelExtra}
                    </div>
                    {description && (
                        <p className="mt-1 max-w-2xl text-sm leading-5 text-content-muted">
                            {description}
                        </p>
                    )}
                </div>
                <div className="min-w-0 w-full sm:w-auto sm:max-w-[50%]">
                    {children}
                </div>
            </div>
        </SettingsFieldContext.Provider>
    );
}
