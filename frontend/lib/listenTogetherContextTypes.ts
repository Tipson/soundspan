import type {
    AvailabilityItem,
    GroupSnapshot,
    QueueTrackInput,
} from "@/lib/listen-together-socket";

/** Options accepted when creating a Listen Together group. */
export interface CreateGroupOptions {
    name?: string;
    visibility?: "public" | "private";
    useCurrentQueue?: boolean;
}

/** Result of the Listen Together socket-route preflight. */
export type SocketRouteStatus = "checking" | "ok" | "failed";

/** Public state and commands exposed by the Listen Together provider. */
export interface ListenTogetherContextType {
    activeGroup: GroupSnapshot | null;
    isInGroup: boolean;
    isHost: boolean;
    canControl: boolean;
    canEditQueue: boolean;
    isLoading: boolean;
    isConnected: boolean;
    hasConnectedOnce: boolean;
    reconnectAttempt: number;
    error: string | null;
    socketRouteStatus: SocketRouteStatus;
    socketRouteError: string | null;
    canUseListenTogether: boolean;
    createGroup: (
        options?: CreateGroupOptions,
    ) => Promise<GroupSnapshot | null>;
    joinGroup: (joinCode: string) => Promise<GroupSnapshot | null>;
    leaveGroup: () => Promise<void>;
    clearError: () => void;
    recheckSocketRoute: () => Promise<boolean>;
    syncPlay: () => void;
    syncPause: () => void;
    syncSeek: (positionMs: number) => void;
    syncNext: () => void;
    syncPrevious: () => void;
    syncSetTrack: (index: number) => void;
    syncAddToQueue: (tracks: QueueTrackInput[]) => void;
    syncRemoveFromQueue: (index: number) => void;
    syncClearQueue: () => void;
    trackAvailability: Map<number, AvailabilityItem>;
}
