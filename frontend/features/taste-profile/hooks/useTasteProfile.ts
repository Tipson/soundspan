"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import {
    createTasteProfile,
    getTasteProfile,
    replaceTasteProfile,
    skipTasteProfile,
} from "../api";
import {
    normalizeTasteProfileSelection,
    validateTasteProfileSelection,
} from "../model";
import type {
    TasteProfileSelection,
    TasteProfileState,
    TasteProfileWriteMode,
} from "../types";

type TasteProfileMutation =
    | {
          accountId: string;
          action: "save";
          mode: TasteProfileWriteMode;
          selection: TasteProfileSelection;
      }
    | {
          accountId: string;
          action: "skip";
          mode: TasteProfileWriteMode;
      };

/** Account-keyed query and writes for first-run and later taste editing. */
export function useTasteProfile(accountId: string, enabled: boolean = true) {
    const queryClient = useQueryClient();
    const normalizedAccountId = accountId.trim();
    const profileQuery = useQuery({
        queryKey: queryKeys.tasteProfile(normalizedAccountId),
        queryFn: ({ signal }) => getTasteProfile(signal),
        enabled: enabled && normalizedAccountId.length > 0,
        staleTime: 60_000,
        retry: 1,
    });
    const mutation = useMutation({
        mutationFn: async (
            variables: TasteProfileMutation,
        ): Promise<TasteProfileState> => {
            if (!variables.accountId) {
                throw new Error("Account ID is required");
            }
            if (variables.action === "skip") {
                return skipTasteProfile(variables.mode);
            }
            const selection = normalizeTasteProfileSelection(
                variables.selection,
            );
            const validation = validateTasteProfileSelection(selection);
            if (validation.code !== "valid") {
                throw new TypeError(validation.message ?? "Invalid selection");
            }
            return variables.mode === "create"
                ? createTasteProfile(selection)
                : replaceTasteProfile(selection);
        },
        onSuccess: (state, variables) => {
            queryClient.setQueryData(
                queryKeys.tasteProfile(variables.accountId),
                state,
            );
            void queryClient.invalidateQueries({
                queryKey: queryKeys.personalizedHomeAll(),
            });
        },
    });

    const create = (selection: TasteProfileSelection) =>
        mutation.mutateAsync({
            accountId: normalizedAccountId,
            action: "save",
            mode: "create",
            selection,
        });
    const replace = (selection: TasteProfileSelection) =>
        mutation.mutateAsync({
            accountId: normalizedAccountId,
            action: "save",
            mode: "replace",
            selection,
        });
    const skip = (mode: TasteProfileWriteMode = "create") =>
        mutation.mutateAsync({
            accountId: normalizedAccountId,
            action: "skip",
            mode,
        });

    return {
        state: profileQuery.data ?? null,
        isLoading: profileQuery.isLoading,
        error: profileQuery.error ?? mutation.error ?? null,
        isSaving: mutation.isPending,
        refetch: profileQuery.refetch,
        create,
        replace,
        skip,
    };
}
