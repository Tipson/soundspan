import type { SavedMusicEntity, SavedMusicEntityType } from "@/lib/api";

/** Exact opt-in query/page receipt required from the account collection API. */
export interface SavedEntitySearchRequest {
    query: string;
    type: SavedMusicEntityType;
    offset: number;
    limit: number;
}

/** Valid visible references and progress over the unfiltered transport window. */
export interface SavedEntitySearchPage {
    items: SavedMusicEntity[];
    total: number;
    nextOffset: number | undefined;
    partial: boolean;
}

/** Validate the account response before admitting it as personal search matches. */
export function parseSavedEntitySearchPage(
    value: unknown,
    request: SavedEntitySearchRequest,
): SavedEntitySearchPage {
    const page = object(value),
        echo = object(page?.search);
    if (
        !page ||
        !echo ||
        echo.query !== request.query ||
        echo.offset !== request.offset ||
        echo.limit !== request.limit ||
        !Array.isArray(page.items) ||
        page.items.length > request.limit ||
        typeof page.total !== "number" ||
        !Number.isSafeInteger(page.total) ||
        page.total < 0 ||
        (page.items.length === 0 && page.total > request.offset)
    ) {
        throw new Error(
            "Сервер не подтвердил поиск по коллекции. Остальные результаты сохранены.",
        );
    }
    const items: SavedMusicEntity[] = [],
        seen = new Set<string>();
    let partial = false;
    for (const raw of page.items) {
        const row = object(raw);
        if (
            !row ||
            row.entityType !== request.type ||
            !text(row.id, 512, true) ||
            !text(row.entityId, 512, true) ||
            !text(row.title, 300) ||
            (row.source !== "library" &&
                row.source !== "discovery" &&
                row.source !== "ytmusic") ||
            !(row.subtitle === null || text(row.subtitle, 300)) ||
            !(
                row.imageUrl === null ||
                (text(row.imageUrl, 2048) && safeImage(row.imageUrl))
            )
        ) {
            partial = true;
            continue;
        }
        const key = `${request.type}:${row.source}:${row.entityId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
            id: row.id,
            entityType: request.type,
            source: row.source,
            entityId: row.entityId,
            title: row.title,
            subtitle: row.subtitle,
            imageUrl: row.imageUrl,
        });
    }
    const consumed = request.offset + page.items.length;
    const hasMore = consumed < page.total;
    if (hasMore && consumed > 100_000) partial = true;
    return {
        items,
        total: page.total,
        nextOffset: hasMore && consumed <= 100_000 ? consumed : undefined,
        partial,
    };
}

function object(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}
function text(value: unknown, max: number, identity = false): value is string {
    return (
        typeof value === "string" &&
        value.trim().length > 0 &&
        value.length <= max &&
        (!identity || !/[\u0000-\u001f\u007f]/.test(value))
    );
}
function safeImage(value: string): boolean {
    return (
        /^(?:https?:\/\/|native:|\/(?!\/))/i.test(value) ||
        /^[a-zA-Z0-9._/-]+$/.test(value)
    );
}
