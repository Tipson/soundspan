import { mixSnapshotDetails } from "../mixSnapshot";

/** A quiet status for the actual composition, independent of query age. */
export function MixSnapshotCaption({ snapshot }: { snapshot?: unknown }) {
    const { dateTime, dateLabel, detail } = mixSnapshotDetails(snapshot);
    if (!dateLabel && !detail) return null;
    return (
        <span className="mt-1 block text-xs leading-5 text-content-muted">
            {dateLabel && <time dateTime={dateTime}>{dateLabel}</time>}
            {detail && <span className="block">{detail}</span>}
        </span>
    );
}
