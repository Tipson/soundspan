"use client";

import {
    useInfiniteQuery,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
    api,
    type SavedMusicEntity,
    type SavedMusicEntityInput,
    type SavedMusicEntityStatusResponse,
    type SavedMusicEntityType,
} from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

const EMPTY_SAVED_ITEMS: SavedMusicEntity[] = [];

/** Load one saved-entity collection for the personal Library. */
export function useSavedMusicEntities(
    type: SavedMusicEntityType,
    pageSize = 60,
) {
    const query = useInfiniteQuery({
        queryKey: queryKeys.savedMusic(type, pageSize, 0),
        initialPageParam: 0,
        queryFn: ({ pageParam }) =>
            api.listSavedMusicEntities({
                type,
                limit: pageSize,
                offset: pageParam,
            }),
        getNextPageParam: (lastPage, pages) => {
            if (lastPage.items.length === 0) return undefined;
            const loaded = pages.reduce(
                (total, page) => total + page.items.length,
                0,
            );
            return loaded < lastPage.total ? loaded : undefined;
        },
        staleTime: 60_000,
    });
    const pages = query.data?.pages;

    return {
        items: pages ? pages.flatMap((page) => page.items) : EMPTY_SAVED_ITEMS,
        total: pages?.[0]?.total ?? 0,
        isLoading: query.isLoading,
        isError: query.isError,
        hasNextPage: query.hasNextPage,
        isFetchingNextPage: query.isFetchingNextPage,
        fetchNextPage: query.fetchNextPage,
        refetch: query.refetch,
    };
}

function optimisticSavedEntity(
    entity: SavedMusicEntityInput,
): SavedMusicEntity {
    return {
        id: `optimistic:${entity.type}:${entity.source}:${entity.entityId}`,
        entityType: entity.type,
        source: entity.source,
        entityId: entity.entityId,
        title: entity.title,
        subtitle: entity.subtitle,
        imageUrl: entity.imageUrl,
    };
}

/** Resolve and toggle one explicit account-level album or artist save. */
export function useSavedMusicEntity(entity: SavedMusicEntityInput | null) {
    const queryClient = useQueryClient();
    const identity = entity
        ? {
              type: entity.type,
              source: entity.source,
              entityId: entity.entityId,
          }
        : null;
    const statusKey = queryKeys.savedMusicStatus(
        identity?.type ?? "unknown",
        identity?.source ?? "unknown",
        identity?.entityId ?? "unknown",
    );
    const statusQuery = useQuery({
        queryKey: statusKey,
        queryFn: () => {
            if (!identity) throw new Error("Saved music identity is required");
            return api.getSavedMusicEntityStatus(identity);
        },
        enabled: Boolean(identity),
        staleTime: 60_000,
        retry: 1,
    });
    const isSaved = statusQuery.data?.saved ?? false;

    const mutation = useMutation({
        mutationFn: async (nextSaved: boolean) => {
            if (!entity || !identity) {
                throw new Error("Saved music entity is required");
            }
            if (nextSaved) return api.saveMusicEntity(entity);
            return api.removeSavedMusicEntity(identity);
        },
        onMutate: async (nextSaved) => {
            await queryClient.cancelQueries({ queryKey: statusKey });
            const previous =
                queryClient.getQueryData<SavedMusicEntityStatusResponse>(
                    statusKey,
                );
            queryClient.setQueryData<SavedMusicEntityStatusResponse>(
                statusKey,
                {
                    saved: nextSaved,
                    item:
                        nextSaved && entity
                            ? optimisticSavedEntity(entity)
                            : null,
                },
            );
            return { previous };
        },
        onError: (_error, _nextSaved, context) => {
            queryClient.setQueryData(statusKey, context?.previous);
            toast.error("Не удалось обновить коллекцию");
        },
        onSuccess: (_response, nextSaved) => {
            toast.success(
                nextSaved ? "Сохранено в коллекции" : "Удалено из коллекции",
            );
        },
        onSettled: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: statusKey }),
                queryClient.invalidateQueries({
                    queryKey: queryKeys.savedMusicAll(),
                }),
            ]);
        },
    });

    return {
        isSaved,
        isLoading: Boolean(entity) && statusQuery.isLoading,
        isError: statusQuery.isError,
        isMutating: mutation.isPending,
        toggle: () => mutation.mutateAsync(!isSaved),
    };
}
