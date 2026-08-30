import type { ScrobblingStatus } from "@/lib/api/scrobbling";

/** Names the server value(s) the operator still needs to set. */
export function missingLastFmValues(
    status: ScrobblingStatus["lastfm"],
): string {
    const missing = [
        !status.apiKeyConfigured && "LASTFM_API_KEY",
        !status.sharedSecretConfigured && "LASTFM_SHARED_SECRET",
    ].filter(Boolean);
    return missing.length > 0
        ? missing.join(" и ")
        : "LASTFM_API_KEY и LASTFM_SHARED_SECRET";
}

/** Row description for the Last.fm scrobbling settings entry. */
export function lastFmDescription(status: ScrobblingStatus["lastfm"]): string {
    if (!status.serverConfigured) {
        const missing = missingLastFmValues(status);
        return status.connected
            ? `На сервере не заданы ${missing}; скробблинг может не работать. Сервис всё ещё можно отключить.`
            : `Скробблинг Last.fm недоступен: на сервере не заданы ${missing}. Обратитесь к администратору сервера.`;
    }
    return "Войдите в Last.fm, чтобы сохранять историю прослушиваний";
}
