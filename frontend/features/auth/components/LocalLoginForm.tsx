"use client";

import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { TwoFactorInput } from "./TwoFactorInput";
import { ru, userFacingError } from "@/lib/i18n/ru";

function isSecondFactorRequired(message: string): boolean {
    return (
        message.includes("2FA token required") ||
        message.includes("requires2FA")
    );
}

function isSecondFactorError(message: string): boolean {
    return (
        message.includes("Invalid 2FA token") ||
        message.includes("Invalid recovery code")
    );
}

function useLocalLoginForm() {
    const { login } = useAuth();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [twoFactorToken, setTwoFactorToken] = useState("");
    const [requires2FA, setRequires2FA] = useState(false);
    const [useRecoveryCode, setUseRecoveryCode] = useState(false);
    const [error, setError] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const resetSecondFactor = (): void => {
        setRequires2FA(false);
        setTwoFactorToken("");
        setUseRecoveryCode(false);
        setError("");
    };
    const handleFailure = (caught: unknown): void => {
        const message =
            caught instanceof Error ? caught.message : ru.auth.loginFailed;
        if (isSecondFactorRequired(message)) {
            setRequires2FA(true);
            setError("");
            return;
        }
        setError(userFacingError(caught, ru.auth.loginFailed));
        setTwoFactorToken("");
        if (!isSecondFactorError(message)) setRequires2FA(false);
    };
    const handleSubmit = async (event: FormEvent): Promise<void> => {
        event.preventDefault();
        setError("");
        setIsLoading(true);
        try {
            await login(
                username,
                password,
                requires2FA ? twoFactorToken : undefined,
            );
        } catch (caught) {
            handleFailure(caught);
        } finally {
            setIsLoading(false);
        }
    };
    return {
        username,
        password,
        twoFactorToken,
        requires2FA,
        useRecoveryCode,
        error,
        isLoading,
        setUsername,
        setPassword,
        setTwoFactorToken,
        setUseRecoveryCode,
        resetSecondFactor,
        handleSubmit,
    };
}

type LocalLoginFormState = ReturnType<typeof useLocalLoginForm>;

/** Renders the existing username/password login and local 2FA flow. */
export function LocalLoginForm() {
    const form = useLocalLoginForm();
    return (
        <form onSubmit={form.handleSubmit} className="space-y-4">
            <LoginError message={form.error} />
            {form.requires2FA ? (
                <LocalSecondFactor form={form} />
            ) : (
                <LocalCredentialFields form={form} />
            )}
            <SubmitButton isLoading={form.isLoading} />
            {form.requires2FA && (
                <button
                    type="button"
                    onClick={form.resetSecondFactor}
                    className="inline-flex min-h-11 w-full items-center justify-center rounded-xl px-3 text-xs font-semibold text-content-muted transition-colors hover:bg-white/[0.05] hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                >
                    ← {ru.auth.backToLogin}
                </button>
            )}
        </form>
    );
}

function LoginError({ message }: { message: string }) {
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

function LocalSecondFactor({ form }: { form: LocalLoginFormState }) {
    return (
        <div className="animate-fade-in space-y-4">
            <div className="rounded-2xl border border-brand/20 bg-brand/10 p-4">
                <p className="mb-1 text-sm font-semibold text-content">
                    {ru.auth.twoFactorRequired}
                </p>
                <p className="text-xs text-content-secondary">
                    {ru.auth.loggingInAs} <strong>{form.username}</strong>
                </p>
            </div>
            <TwoFactorInput
                id="twoFactorToken"
                value={form.twoFactorToken}
                useRecoveryCode={form.useRecoveryCode}
                onValueChange={form.setTwoFactorToken}
                onRecoveryCodeChange={form.setUseRecoveryCode}
            />
        </div>
    );
}

function LocalCredentialFields({ form }: { form: LocalLoginFormState }) {
    return (
        <>
            <CredentialInput
                id="username"
                label={ru.auth.usernameOrEmail}
                type="text"
                value={form.username}
                onChange={form.setUsername}
                placeholder={ru.auth.usernamePlaceholder}
                autoComplete="username"
                autoFocus
            />
            <CredentialInput
                id="password"
                label={ru.auth.password}
                type="password"
                value={form.password}
                onChange={form.setPassword}
                placeholder={ru.auth.passwordPlaceholder}
                autoComplete="current-password"
            />
        </>
    );
}

interface CredentialInputProps {
    id: string;
    label: string;
    type: "text" | "password";
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    autoComplete: string;
    autoFocus?: boolean;
}

function CredentialInput(props: CredentialInputProps) {
    return (
        <div>
            <label
                htmlFor={props.id}
                className="mb-1.5 block text-sm font-medium text-content"
            >
                {props.label}
            </label>
            <input
                id={props.id}
                type={props.type}
                value={props.value}
                onChange={(event) => props.onChange(event.target.value)}
                placeholder={props.placeholder}
                required
                autoFocus={props.autoFocus}
                autoComplete={props.autoComplete}
                autoCapitalize="none"
                autoCorrect="off"
                className="min-h-12 w-full rounded-2xl border border-line bg-surface-elevated px-4 py-3 text-base text-content outline-none transition-colors placeholder:text-content-muted hover:border-line-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/20 sm:text-sm"
            />
        </div>
    );
}

function SubmitButton({ isLoading }: { isLoading: boolean }) {
    return (
        <button
            type="submit"
            disabled={isLoading}
            className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-brand px-5 py-3 text-sm font-black text-black transition-[transform,background-color] active:scale-[0.98] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
        >
            <span className="flex items-center justify-center gap-2">
                {isLoading ? (
                    <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        {ru.auth.signingIn}
                    </>
                ) : (
                    <>{ru.auth.signIn}</>
                )}
            </span>
        </button>
    );
}
