"use client";

import { ru } from "@/lib/i18n/ru";

/** Props for the shared local-authentication second-factor control. */
export interface TwoFactorInputProps {
    id: string;
    value: string;
    useRecoveryCode: boolean;
    onValueChange: (value: string) => void;
    onRecoveryCodeChange: (useRecoveryCode: boolean) => void;
}

function normalizeSecondFactor(value: string, recoveryCode: boolean): string {
    return recoveryCode
        ? value
              .replace(/[^A-Fa-f0-9]/g, "")
              .slice(0, 8)
              .toUpperCase()
        : value.replace(/\D/g, "").slice(0, 6);
}

type SecondFactorFieldProps = Omit<TwoFactorInputProps, "onRecoveryCodeChange">;

function SecondFactorField({
    id,
    value,
    useRecoveryCode,
    onValueChange,
}: SecondFactorFieldProps) {
    const label = useRecoveryCode
        ? ru.auth.recoveryCode
        : ru.auth.authenticationCode;
    return (
        <div>
            <label
                htmlFor={id}
                className="mb-1.5 block text-sm font-medium text-content"
            >
                {label}
            </label>
            <input
                id={id}
                type="text"
                value={value}
                onChange={(event) =>
                    onValueChange(
                        normalizeSecondFactor(
                            event.target.value,
                            useRecoveryCode,
                        ),
                    )
                }
                placeholder={useRecoveryCode ? "ABCD1234" : "000000"}
                maxLength={useRecoveryCode ? 8 : 6}
                required
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                inputMode={useRecoveryCode ? "text" : "numeric"}
                autoComplete="one-time-code"
                className="min-h-12 w-full rounded-2xl border border-brand/30 bg-surface-elevated px-4 py-3 text-center text-2xl tracking-widest text-content outline-none transition-colors placeholder:text-content-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/25"
            />
            <p className="mt-2 text-xs text-content-muted">
                {useRecoveryCode
                    ? ru.auth.recoveryHint
                    : ru.auth.authenticationHint}
            </p>
        </div>
    );
}

/** Renders a TOTP input with the existing recovery-code alternative. */
export function TwoFactorInput({
    id,
    value,
    useRecoveryCode,
    onValueChange,
    onRecoveryCodeChange,
}: TwoFactorInputProps) {
    return (
        <div className="space-y-4">
            <SecondFactorField
                id={id}
                value={value}
                useRecoveryCode={useRecoveryCode}
                onValueChange={onValueChange}
            />
            <div className="flex items-center justify-center">
                <button
                    type="button"
                    onClick={() => {
                        onValueChange("");
                        onRecoveryCodeChange(!useRecoveryCode);
                    }}
                    className="inline-flex min-h-11 items-center justify-center rounded-xl px-3 text-xs font-semibold text-brand-light underline transition-colors hover:bg-white/[0.05] hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                >
                    {useRecoveryCode
                        ? ru.auth.useAuthenticator
                        : ru.auth.useRecovery}
                </button>
            </div>
        </div>
    );
}
