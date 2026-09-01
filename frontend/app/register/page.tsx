"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { ru } from "@/lib/i18n/ru";
import { AuthPanel, AuthStage } from "@/features/auth/components/AuthStage";

const inputClassName =
    "min-h-12 w-full rounded-2xl border border-line bg-surface-elevated px-4 py-3 text-base text-content outline-none transition-colors placeholder:text-content-muted hover:border-line-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/20 sm:text-sm";
const labelClassName = "mb-1.5 block text-sm font-medium text-content";

function InviteCodePrefill({
    setInviteCode,
}: {
    setInviteCode: (code: string) => void;
}) {
    const searchParams = useSearchParams();

    useEffect(() => {
        const code = searchParams.get("code");
        if (code) {
            setInviteCode(code.toUpperCase());
        }
    }, [searchParams, setInviteCode]);

    return null;
}

/**
 * Renders the RegisterPage component.
 */
export default function RegisterPage() {
    const router = useRouter();
    const [inviteCode, setInviteCode] = useState("");
    const [username, setUsername] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [checkingStatus, setCheckingStatus] = useState(true);

    // If no users exist, redirect to onboarding (the canonical bootstrap flow)
    useEffect(() => {
        const checkStatus = async () => {
            try {
                const status = await api.get<{ hasAccount: boolean }>(
                    "/onboarding/status",
                );
                if (!status.hasAccount) {
                    router.replace("/onboarding");
                    return;
                }
            } catch {
                // If check fails, show register form (fail open)
            }
            setCheckingStatus(false);
        };
        checkStatus();
    }, [router]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        if (password !== confirmPassword) {
            setError(ru.auth.passwordsMismatch);
            return;
        }

        setIsLoading(true);
        try {
            await api.register({
                inviteCode,
                username,
                displayName,
                password,
                confirmPassword,
                email,
            });
            router.push("/");
        } catch (err) {
            setError(
                err instanceof Error ? err.message : ru.auth.registrationFailed,
            );
        } finally {
            setIsLoading(false);
        }
    };

    if (checkingStatus) {
        return (
            <AuthStage footer={false}>
                <AuthPanel>
                    <div
                        role="status"
                        className="flex items-center justify-center gap-3 py-8 text-content-secondary"
                    >
                        <Loader2 className="h-7 w-7 animate-spin motion-reduce:animate-none" />
                        Проверяем приглашение…
                    </div>
                </AuthPanel>
            </AuthStage>
        );
    }

    return (
        <>
            <Suspense fallback={null}>
                <InviteCodePrefill setInviteCode={setInviteCode} />
            </Suspense>
            <AuthStage>
                <AuthPanel>
                    <p className="text-center text-[0.68rem] font-bold uppercase tracking-[0.18em] text-brand-light">
                        Доступ по приглашению
                    </p>
                    <h1 className="mt-2 text-center text-2xl font-black tracking-[-0.035em] text-content sm:text-3xl">
                        {ru.auth.createTitle}
                    </h1>
                    <p className="mb-7 mt-2 text-center text-sm leading-6 text-content-secondary">
                        {ru.auth.inviteSubtitle}
                    </p>

                    <form onSubmit={handleSubmit} className="space-y-4">
                        {error && (
                            <div
                                role="alert"
                                className="rounded-2xl border border-red-400/25 bg-red-500/10 p-4 text-sm leading-5 text-red-200"
                            >
                                {error}
                            </div>
                        )}

                        <AuthInput
                            id="inviteCode"
                            label={ru.auth.inviteCode}
                            value={inviteCode}
                            onChange={(value) =>
                                setInviteCode(value.toUpperCase())
                            }
                            placeholder="ABCD1234"
                            autoComplete="one-time-code"
                            autoFocus
                            className="text-center font-mono tracking-widest"
                        />
                        <AuthInput
                            id="username"
                            label={ru.auth.username}
                            value={username}
                            onChange={setUsername}
                            placeholder={ru.auth.chooseUsername}
                            autoComplete="username"
                        />
                        <AuthInput
                            id="displayName"
                            label={ru.auth.displayName}
                            value={displayName}
                            onChange={setDisplayName}
                            placeholder={ru.auth.displayNamePlaceholder}
                            autoComplete="name"
                        />
                        <AuthInput
                            id="email"
                            label={ru.auth.email}
                            type="email"
                            value={email}
                            onChange={setEmail}
                            placeholder="you@example.com"
                            autoComplete="email"
                        />
                        <AuthInput
                            id="password"
                            label={ru.auth.password}
                            type="password"
                            value={password}
                            onChange={setPassword}
                            placeholder={ru.auth.passwordLength}
                            autoComplete="new-password"
                            minLength={6}
                        />
                        <AuthInput
                            id="confirmPassword"
                            label={ru.auth.confirmPassword}
                            type="password"
                            value={confirmPassword}
                            onChange={setConfirmPassword}
                            placeholder={ru.auth.confirmPasswordPlaceholder}
                            autoComplete="new-password"
                            minLength={6}
                        />

                        <button
                            type="submit"
                            disabled={isLoading}
                            className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-brand px-5 py-3 text-sm font-black text-black transition-[transform,background-color] active:scale-[0.98] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                        >
                            <span className="flex items-center justify-center gap-2">
                                {isLoading ? (
                                    <>
                                        <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />
                                        {ru.auth.creatingAccount}
                                    </>
                                ) : (
                                    ru.auth.signUp
                                )}
                            </span>
                        </button>
                    </form>

                    <p className="mt-6 text-center text-sm text-content-muted">
                        {ru.auth.hasAccount}{" "}
                        <Link
                            href="/login"
                            className="inline-flex min-h-11 items-center rounded-lg px-2 font-semibold text-brand-light transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                        >
                            {ru.auth.signIn}
                        </Link>
                    </p>
                </AuthPanel>
            </AuthStage>
        </>
    );
}

interface AuthInputProps {
    id: string;
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    autoComplete: string;
    type?: "text" | "email" | "password";
    autoFocus?: boolean;
    minLength?: number;
    className?: string;
}

function AuthInput({
    id,
    label,
    value,
    onChange,
    placeholder,
    autoComplete,
    type = "text",
    autoFocus,
    minLength,
    className = "",
}: AuthInputProps) {
    return (
        <div>
            <label htmlFor={id} className={labelClassName}>
                {label}
            </label>
            <input
                id={id}
                name={id}
                type={type}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                placeholder={placeholder}
                required
                autoFocus={autoFocus}
                minLength={minLength}
                autoComplete={autoComplete}
                autoCapitalize="none"
                autoCorrect="off"
                className={`${inputClassName} ${className}`}
            />
        </div>
    );
}
