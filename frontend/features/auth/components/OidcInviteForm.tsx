"use client";

import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { ru, userFacingError } from "@/lib/i18n/ru";

/** Props for the OIDC invite-code provisioning form. */
export interface OidcInviteFormProps {
    inviteToken: string;
    onAuthenticated: () => void;
}

function useOidcInviteForm({
    inviteToken,
    onAuthenticated,
}: OidcInviteFormProps) {
    const [inviteCode, setInviteCode] = useState("");
    const [error, setError] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const handleSubmit = async (event: FormEvent): Promise<void> => {
        event.preventDefault();
        setError("");
        setIsLoading(true);
        try {
            await api.redeemOidcInvite({ inviteToken, inviteCode });
            onAuthenticated();
        } catch (caught) {
            setError(userFacingError(caught, ru.auth.redeemInviteFailed));
        } finally {
            setIsLoading(false);
        }
    };
    return { inviteCode, setInviteCode, error, isLoading, handleSubmit };
}

type OidcInviteFormState = ReturnType<typeof useOidcInviteForm>;

/** Collects an invite code before provisioning an OIDC-authenticated account. */
export function OidcInviteForm(props: OidcInviteFormProps) {
    const form = useOidcInviteForm(props);
    return (
        <form onSubmit={form.handleSubmit} className="space-y-4">
            <p className="text-sm leading-6 text-content-secondary">
                {ru.auth.oidcInviteDescription}
            </p>
            <InviteError message={form.error} />
            <InviteCodeField form={form} />
            <button
                type="submit"
                disabled={form.isLoading}
                className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-brand px-5 py-3 text-sm font-black text-black transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:opacity-50"
            >
                {form.isLoading && (
                    <Loader2 className="inline w-5 h-5 mr-2 animate-spin" />
                )}
                {ru.auth.createAccountAndSignIn}
            </button>
        </form>
    );
}

function InviteError({ message }: { message: string }) {
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

function InviteCodeField({ form }: { form: OidcInviteFormState }) {
    return (
        <div>
            <label
                htmlFor="oidcInviteCode"
                className="mb-1.5 block text-sm font-medium text-content"
            >
                {ru.auth.inviteCode}
            </label>
            <input
                id="oidcInviteCode"
                type="text"
                value={form.inviteCode}
                onChange={(event) => form.setInviteCode(event.target.value)}
                required
                autoFocus
                autoCapitalize="characters"
                autoCorrect="off"
                autoComplete="one-time-code"
                className="min-h-12 w-full rounded-2xl border border-line bg-surface-elevated px-4 py-3 text-center text-base font-semibold tracking-[0.18em] text-content outline-none transition-colors hover:border-line-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/20"
            />
        </div>
    );
}
