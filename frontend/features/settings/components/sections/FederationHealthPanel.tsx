"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type {
    FederationHealthState,
    FederationPeerHealth,
} from "@/lib/api/federation";
import {
    adminManagementRu,
    federationHealthStateLabel,
    federationPeerErrorDetail,
    formatFederationFreshness,
} from "@/lib/i18n/adminManagementRu";

const stateTone: Record<FederationHealthState, string> = {
    green: "bg-green-500/15 text-green-300",
    amber: "bg-amber-500/15 text-amber-300",
    red: "bg-red-500/15 text-red-300",
    revoked: "bg-gray-500/15 text-gray-300",
};
const MAX_HEALTH_PEERS = 500;

function leaseUsage(peer: FederationPeerHealth): string {
    return peer.maxConcurrentStreams === null
        ? `${adminManagementRu.federation.health.activeStreams}: ${peer.activeStreamLeases}`
        : `${adminManagementRu.federation.health.activeStreams}: ${peer.activeStreamLeases} из ${peer.maxConcurrentStreams}`;
}

function embeddingStateLabel(
    outcome: FederationPeerHealth["lastEmbeddingOutcome"],
): string | null {
    if (outcome === "active") {
        return adminManagementRu.federation.health.embeddingsActive;
    }
    if (outcome === "skipped_mismatch") {
        return adminManagementRu.federation.health.embeddingsMismatch;
    }
    return null;
}

function HealthStateChip({ state }: { state: FederationHealthState }) {
    return (
        <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${stateTone[state]}`}
        >
            {federationHealthStateLabel(state)}
        </span>
    );
}

function CatalogSummary({
    catalog,
}: {
    catalog: FederationPeerHealth["catalog"];
}) {
    return (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-400">
            <span>
                {catalog.artist} {adminManagementRu.federation.health.artists}
            </span>
            <span>
                {catalog.album} {adminManagementRu.federation.health.albums}
            </span>
            <span>
                {catalog.track} {adminManagementRu.federation.health.tracks}
            </span>
            <span>
                {catalog.audiobook}{" "}
                {adminManagementRu.federation.health.audiobooks}
            </span>
            <span>
                {catalog.podcast} {adminManagementRu.federation.health.podcasts}
            </span>
        </div>
    );
}

function FederationHealthCard({
    peer,
    now,
}: {
    peer: FederationPeerHealth;
    now: Date;
}) {
    const consumesCatalog = peer.direction !== "HOST";
    const hostsStreams = peer.direction !== "CONSUMER";
    return (
        <article className="rounded-lg border border-white/[0.06] bg-surface-hover p-4">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h4 className="text-sm font-medium text-white">
                        {peer.name}
                    </h4>
                    <p className="mt-0.5 text-xs text-gray-500">
                        {peer.direction === "BOTH"
                            ? adminManagementRu.federation.health
                                  .sharingAndConsuming
                            : peer.direction === "HOST"
                              ? adminManagementRu.federation.health.sharingOnly
                              : adminManagementRu.federation.health
                                    .consumingOnly}
                    </p>
                </div>
                <HealthStateChip state={peer.health} />
            </div>
            <div className="mt-3 space-y-2">
                <p className="text-xs text-gray-300">
                    {adminManagementRu.federation.health.sync}:{" "}
                    {consumesCatalog
                        ? formatFederationFreshness(peer.lastSyncSuccessAt, now)
                        : adminManagementRu.federation.health.notApplicable}
                    {consumesCatalog &&
                        peer.lastSyncDurationMs !== null &&
                        ` · ${adminManagementRu.federation.health.duration} ${(peer.lastSyncDurationMs / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} с`}
                </p>
                {consumesCatalog && <CatalogSummary catalog={peer.catalog} />}
                {hostsStreams && (
                    <p className="text-xs text-gray-400">{leaseUsage(peer)}</p>
                )}
                {consumesCatalog &&
                    embeddingStateLabel(peer.lastEmbeddingOutcome) && (
                        <p className="text-xs text-gray-400">
                            {embeddingStateLabel(peer.lastEmbeddingOutcome)}
                        </p>
                    )}
                {peer.lastError && (
                    <div className="flex items-start gap-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-200">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{federationPeerErrorDetail(peer)}</span>
                    </div>
                )}
            </div>
        </article>
    );
}

/** Renders a bounded peer-health card collection. */
export function FederationHealthCards({
    peers,
    now = new Date(),
}: {
    peers: FederationPeerHealth[];
    now?: Date;
}) {
    if (peers.length === 0) {
        return (
            <p className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center text-sm text-gray-400">
                {adminManagementRu.federation.health.empty}
            </p>
        );
    }
    return (
        <div className="grid gap-3 lg:grid-cols-2">
            {peers.slice(0, MAX_HEALTH_PEERS).map((peer) => (
                <FederationHealthCard key={peer.id} peer={peer} now={now} />
            ))}
        </div>
    );
}

function HealthPanelHeader({
    loading,
    onRefresh,
}: {
    loading: boolean;
    onRefresh: () => void;
}) {
    return (
        <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-gray-400" />
                <h3
                    id="federation-health-title"
                    className="text-sm font-medium text-white"
                >
                    {adminManagementRu.federation.health.title}
                </h3>
            </div>
            <button
                type="button"
                onClick={onRefresh}
                disabled={loading}
                className="rounded-full border border-white/15 p-1.5 text-gray-300 disabled:opacity-50"
                aria-label={adminManagementRu.federation.health.refresh}
            >
                <RefreshCw
                    className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                />
            </button>
        </div>
    );
}

/** Loads and renders the administrator federation peer health panel. */
export function FederationHealthPanel() {
    const [peers, setPeers] = useState<FederationPeerHealth[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setPeers((await api.getFederationPeerHealth()).peers);
        } catch {
            setError(adminManagementRu.federation.health.requestFailed);
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => {
        let active = true;
        void api.getFederationPeerHealth().then(
            (response) => {
                if (!active) return;
                setPeers(response.peers);
                setError(null);
                setLoading(false);
            },
            () => {
                if (!active) return;
                setError(adminManagementRu.federation.health.requestFailed);
                setLoading(false);
            },
        );
        return () => {
            active = false;
        };
    }, []);
    return (
        <section
            aria-labelledby="federation-health-title"
            className="space-y-3"
        >
            <HealthPanelHeader
                loading={loading}
                onRefresh={() => void load()}
            />
            {error && (
                <p role="alert" className="text-sm text-red-300">
                    {error}
                </p>
            )}
            {loading ? (
                <p className="text-sm text-gray-400">
                    {adminManagementRu.federation.health.loading}
                </p>
            ) : (
                <FederationHealthCards peers={peers} />
            )}
        </section>
    );
}
