const MARKER = "__soundspanDismissibleLayer";

/** Minimal history boundary, injectable for traversal and lifecycle tests. */
export interface LayerHistoryRuntime {
    url(): string;
    state(): Record<string, unknown> | null;
    push(state: Record<string, unknown>, url?: string): void;
    back(): void;
}

/** One same-URL history guard shared by nested visible layers, never by audio. */
export class DismissibleLayerHistory {
    private readonly layers = new Map<
        number,
        { close: () => void; priority: number }
    >();
    private sequence = 0;
    private readonly marker = `layer-${Date.now()}-${Math.random()}`;
    private baseUrl: string | null = null;
    private baseState: Record<string, unknown> = {};
    private pendingBack = false;
    private consumePendingBack = true;

    constructor(private readonly runtime: LayerHistoryRuntime) {}

    private isGuard(): boolean {
        return (
            this.runtime.state()?.[MARKER] ===
            `${this.marker}:${this.runtime.url()}`
        );
    }

    private pushGuard(): void {
        this.baseUrl = this.runtime.url();
        this.baseState = { ...this.runtime.state() };
        delete this.baseState[MARKER];
        this.runtime.push({
            ...this.runtime.state(),
            [MARKER]: `${this.marker}:${this.baseUrl}`,
        });
    }

    /** Register a layer; higher visual priority wins, then the latest opening. */
    add(close: () => void, priority: number): () => void {
        const id = ++this.sequence;
        if (!this.layers.size && !this.isGuard() && !this.pendingBack)
            this.pushGuard();
        this.layers.set(id, { close, priority });
        return () => {
            this.layers.delete(id);
            this.releaseGuard();
        };
    }

    private releaseGuard(): void {
        if (!this.layers.size && this.isGuard() && !this.pendingBack) {
            this.pendingBack = true;
            this.consumePendingBack = true;
            this.runtime.back();
        }
    }

    /** Close only the uppermost layer; false means the key belongs to the page. */
    dismiss(): boolean {
        const top = [...this.layers].sort(
            (a, b) => b[1].priority - a[1].priority || b[0] - a[0],
        )[0];
        if (!top) return false;
        this.layers.delete(top[0]);
        top[1].close();
        this.releaseGuard();
        return true;
    }

    /** Consume a Back traversal on the guarded URL without changing the route. */
    onPop(): boolean {
        if (!this.layers.size && !this.pendingBack && this.isGuard()) {
            // A closed layer can remain behind a real link navigation, even
            // after another route has opened its own layer. Skip that copy.
            this.baseUrl = this.runtime.url();
            this.pendingBack = true;
            this.consumePendingBack = false;
            this.runtime.back();
            return true;
        }
        if (this.runtime.url() !== this.baseUrl) {
            if (this.layers.size && !this.pendingBack && this.baseUrl) {
                // Browser UI traversal can skip same-document guard entries.
                // Restore the visible page's own router snapshot before the
                // router sees popstate; never copy the destination's tree.
                this.runtime.push(this.baseState, this.baseUrl);
                if (this.layers.size > 1) this.pushGuard();
                return this.dismiss();
            }
            this.pendingBack = false;
            return false;
        }
        if (this.pendingBack) {
            this.pendingBack = false;
            if (this.layers.size) this.pushGuard();
            return this.consumePendingBack;
        }
        if (!this.layers.size) {
            return false;
        }
        // The browser has already removed the guard. Restore it only for
        // remaining nested layers before their close callbacks can unmount.
        if (this.layers.size > 1) this.pushGuard();
        return this.dismiss();
    }
}
