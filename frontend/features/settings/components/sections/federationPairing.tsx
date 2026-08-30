"use client";

import { useState, type FormEvent } from "react";
import { KeyRound, Link as LinkIcon, Loader2, Plus } from "lucide-react";
import type {
    FederationScope,
    LinkFederationPeerInput,
} from "@/lib/api/federation";
import {
    adminManagementRu,
    federationRequestError,
} from "@/lib/i18n/adminManagementRu";

export const DEFAULT_SCOPES: FederationScope[] = [
    "library:read",
    "stream:read",
    "social:read",
];

const inputClassName =
    "w-full rounded-lg border border-white/10 bg-surface px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:border-white/30 focus:outline-none";

/** Maps a federation API failure onto an admin-actionable message. */
export function federationErrorMessage(error: unknown): string {
    return federationRequestError(error);
}

/** Maps the host form's share options onto the credential's scope grant. */
export function buildHostScopes(options: {
    embeddings: boolean;
}): FederationScope[] {
    return [
        ...DEFAULT_SCOPES,
        ...(options.embeddings ? (["embeddings:read"] as const) : []),
    ];
}

/** Maps the connect form onto the link (token) request body. */
export function buildLinkPeerInput(
    name: string,
    baseUrl: string,
    token: string,
): LinkFederationPeerInput {
    return {
        baseUrl,
        token,
        ...(name.trim() ? { name: name.trim() } : {}),
    };
}

function SubmitButton({ busy, label }: { busy: boolean; label: string }) {
    return (
        <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-semibold text-black disabled:opacity-50"
        >
            {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
                <Plus className="h-3.5 w-3.5" />
            )}
            {label}
        </button>
    );
}

/** Host-role form: issue a long-lived credential for a named consumer. */
export function HostCredentialForm({
    onSubmit,
    busy,
}: {
    onSubmit: (name: string, scopes: FederationScope[]) => Promise<void>;
    busy: boolean;
}) {
    const [name, setName] = useState("");
    const [embeddings, setEmbeddings] = useState(false);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        await onSubmit(name, buildHostScopes({ embeddings }));
        setName("");
    };
    return (
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
            <label className="block text-xs text-gray-300">
                {adminManagementRu.federation.shareWithName}
                <input
                    required
                    maxLength={120}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className={`${inputClassName} mt-1`}
                    placeholder={adminManagementRu.federation.familyServer}
                />
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300">
                <input
                    type="checkbox"
                    checked={embeddings}
                    onChange={(event) => setEmbeddings(event.target.checked)}
                />
                {adminManagementRu.federation.shareEmbeddings}
            </label>
            <p className="text-xs text-gray-500">
                {adminManagementRu.federation.presenceExplanation}
            </p>
            <SubmitButton
                busy={busy}
                label={adminManagementRu.federation.issueCredential}
            />
        </form>
    );
}

/** Client-role form: connect to a host with the credential they issued. */
export function ConsumerConnectForm({
    onLink,
    busy,
}: {
    onLink: (name: string, baseUrl: string, token: string) => Promise<void>;
    busy: boolean;
}) {
    const [name, setName] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    const [token, setToken] = useState("");
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        await onLink(name, baseUrl, token);
        setToken("");
    };
    return (
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
            <label className="block text-xs text-gray-300">
                {adminManagementRu.federation.peerName}
                <input
                    maxLength={120}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className={`${inputClassName} mt-1`}
                    placeholder={adminManagementRu.federation.friendServer}
                />
            </label>
            <label className="block text-xs text-gray-300">
                {adminManagementRu.federation.peerUrl}
                <input
                    required
                    type="url"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    className={`${inputClassName} mt-1`}
                    placeholder="https://soundspan.example"
                />
            </label>
            <label className="block text-xs text-gray-300">
                {adminManagementRu.federation.token}
                <input
                    required
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    className={`${inputClassName} mt-1`}
                    autoComplete="off"
                />
            </label>
            <SubmitButton
                busy={busy}
                label={adminManagementRu.federation.connectToken}
            />
        </form>
    );
}

export interface FederationAddPanelProps {
    busy: boolean;
    onHost: (name: string, scopes: FederationScope[]) => Promise<void>;
    onLink: (name: string, baseUrl: string, token: string) => Promise<void>;
}

/** Explicit host/client pairing panel: share and connect are separate acts. */
export function FederationAddPanel(props: FederationAddPanelProps) {
    return (
        <div className="space-y-4">
            <div className="rounded-lg border border-white/[0.06] bg-surface-hover p-4">
                <h4 className="flex items-center gap-2 text-sm font-medium text-white">
                    <KeyRound className="h-4 w-4" />
                    {adminManagementRu.federation.shareLibrary}
                </h4>
                <p className="mt-1 text-xs text-gray-400">
                    {adminManagementRu.federation.shareLibraryDescription}
                </p>
                <div className="mt-3">
                    <HostCredentialForm
                        onSubmit={props.onHost}
                        busy={props.busy}
                    />
                </div>
            </div>
            <div className="rounded-lg border border-white/[0.06] bg-surface-hover p-4">
                <h4 className="flex items-center gap-2 text-sm font-medium text-white">
                    <LinkIcon className="h-4 w-4" />
                    {adminManagementRu.federation.connectLibrary}
                </h4>
                <p className="mt-1 text-xs text-gray-400">
                    {adminManagementRu.federation.connectLibraryDescription}
                </p>
                <div className="mt-3">
                    <ConsumerConnectForm
                        onLink={props.onLink}
                        busy={props.busy}
                    />
                </div>
            </div>
            <p className="text-xs text-gray-500">
                {adminManagementRu.federation.twoWayExplanation}
            </p>
        </div>
    );
}
