/** Search-shaped loading state that preserves the final page hierarchy. */
export default function Loading() {
    return (
        <div
            role="status"
            aria-label="Загрузка результатов поиска"
            className="mx-auto min-h-full max-w-[1520px] px-3 pt-5 sm:px-6 lg:px-8"
        >
            <div className="mb-6 space-y-3" aria-hidden="true">
                <div className="h-3 w-16 animate-pulse rounded-full bg-white/[0.07]" />
                <div className="h-11 w-3/4 max-w-xl animate-pulse rounded-xl bg-white/[0.07] sm:h-14" />
            </div>
            <div
                aria-hidden="true"
                className="mb-9 flex gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.025] p-2"
            >
                {[5, 7, 8, 7].map((width, index) => (
                    <div
                        key={index}
                        className="h-11 animate-pulse rounded-full bg-white/[0.07]"
                        style={{ width: `${width}rem` }}
                    />
                ))}
            </div>
            <div
                aria-hidden="true"
                className="grid items-start gap-6 lg:grid-cols-[minmax(17rem,0.85fr)_minmax(0,1.35fr)]"
            >
                <div>
                    <div className="mb-4 h-7 w-32 animate-pulse rounded bg-white/[0.07]" />
                    <div className="h-60 animate-pulse rounded-[1.5rem] border border-white/[0.06] bg-white/[0.04]" />
                </div>
                <div className="rounded-[1.5rem] border border-white/[0.06] bg-white/[0.025] p-5">
                    <div className="mb-5 h-7 w-24 animate-pulse rounded bg-white/[0.07]" />
                    <div className="space-y-2">
                        {[0, 1, 2, 3, 4].map((index) => (
                            <div
                                key={index}
                                className="h-14 animate-pulse rounded-xl bg-white/[0.05]"
                            />
                        ))}
                    </div>
                </div>
            </div>
            <span className="sr-only">Загрузка результатов поиска…</span>
        </div>
    );
}
