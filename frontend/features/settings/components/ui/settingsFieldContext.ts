"use client";

import { createContext } from "react";

interface SettingsFieldContextValue {
    labelId: string;
    fieldName?: string;
}

/** Shares a settings row's accessible label with its form control. */
export const SettingsFieldContext =
    createContext<SettingsFieldContextValue | null>(null);
