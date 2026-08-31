"use client";

import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { ru, userFacingError } from "@/lib/i18n/ru";
import { TwoFactorInput } from "./TwoFactorInput";

/** Props for the OIDC existing-account confirmation form. */
export interface OidcLinkFormProps {
    linkToken: string;
    onAuthenticated: () => void;
}

function useOidcLinkForm({ linkToken, onAuthenticated }: OidcLinkFormProps) {
    const [password, setPassword] = useState("");
    const [twoFactorToken, setTwoFactorToken] = useState("");
    const [requires2FA, setRequires2FA] = useState(false);
    const [useRecoveryCode, setUseRecoveryCode] = useState(false);
    const [error, setError] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const handleSubmit = async (event: FormEvent): Promise<void> => {
        event.preventDefault();
        setError("");
        setIsLoading(true);
        try {
            const result = await api.confirmOidcLink({
                linkToken,
                password,
                twoFactorToken: requires2FA ? twoFactorToken : undefined,
            });
            if ("requires2FA" in result) {
                setRequires2FA(true);
                return;
            }
            onAuthenticated();
        } catch (caught) {
            setError(userFacingError(caught, ru.auth.linkSsoFailed));
            setTwoFactorToken("");
        } finally {
            setIsLoading(false);
        }
    };
    return {
        password,
        setPassword,
        twoFactorToken,
        setTwoFactorToken,
        requires2FA,
        useRecoveryCode,
        setUseRecoveryCode,
        error,
        isLoading,
        handleSubmit,
    };
}

type OidcLinkFormState = ReturnType<typeof useOidcLinkForm>;

/** Confirms an email-matched account with its local password and optional 2FA. */
export function OidcLinkForm(props: OidcLinkFormProps) {
    const form = useOidcLinkForm(props);
    return (
        <form onSubmit={form.handleSubmit} className="space-y-4">
            <p className="text-sm leading-6 text-content-secondary">
                {ru.auth.oidcLinkDescription}
            </p>
            <LinkError message={form.error} />
            <OidcLinkCredentials form={form} />
            <OidcLinkSubmitButton form={form} />
        </form>
    );
}

function LinkError({ message }: { message: string }) {
    if (!message) return null;
    return (
        <div
            role="alert"
            className="rounded-2xl border border-red-400/25 bg-red-500/10 p-4 text-sm leading-5 text-red-200"
        >
            {message}
        </div>
    );
}

function OidcLinkCredentials({ form }: { form: OidcLinkFormState }) {
    if (form.requires2FA) {
        return (
            <TwoFactorInput
                id="oidcLinkTwoFactorToken"
                value={form.twoFactorToken}
                useRecoveryCode={form.useRecoveryCode}
                onValueChange={form.setTwoFactorToken}
                onRecoveryCodeChange={form.setUseRecoveryCode}
            />
        );
    }
    return (
        <div>
            <label
                htmlFor="oidcLinkPassword"
                className="mb-1.5 block text-sm font-medium text-content"
            >
                {ru.auth.password}
            </label>
            <input
                id="oidcLinkPassword"
                type="password"
                value={form.password}
                onChange={(event) => form.setPassword(event.target.value)}
                required
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="current-password"
                className="min-h-12 w-full rounded-2xl border border-line bg-surface-elevated px-4 py-3 text-base text-content outline-none transition-colors hover:border-line-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/20 sm:text-sm"
            />
        </div>
    );
}

function OidcLinkSubmitButton({ form }: { form: OidcLinkFormState }) {
    return (
        <button
            type="submit"
            disabled={form.isLoading}
            className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-brand px-5 py-3 text-sm font-black text-black transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:opacity-50"
        >
            {form.isLoading && (
                <Loader2 className="inline w-5 h-5 mr-2 animate-spin" />
            )}
            {form.requires2FA
                ? ru.auth.verifyAndSignIn
                : ru.auth.linkAccountAndSignIn}
        </button>
    );
}
