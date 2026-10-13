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
    private queuedNavigation: { callback: () => void; url: string } | null =
        null;

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
        this.queuedNavigation = null;
        const id = ++this.sequence;
        if (!this.layers.size && !this.isGuard() && !this.pendingBack)
            this.pushGuard();
        this.layers.set(id, { close, priority });
        return () => {
            if (this.queuedNavigation?.url !== this.runtime.url())
                this.queuedNavigation = null;
            this.layers.delete(id);
            this.releaseGuard();
        };
    }

    /** Close visible layers, then navigate after their asynchronous guard Back. */
    navigateAfterDismiss(callback: () => void): void {
        const intent = { callback, url: this.runtime.url() };
        this.queuedNavigation = intent;
        // Snapshot only the layers belonging to this intent. A close callback
        // may open a new layer or request a newer navigation.
        const current = [...this.layers].sort(
            (a, b) => b[1].priority - a[1].priority || b[0] - a[0],
        );
        for (const [id, layer] of current) {
            if (this.queuedNavigation !== intent) return;
            if (!this.layers.delete(id)) continue;
            layer.close();
        }
        if (this.queuedNavigation !== intent) return;
        if (this.pendingBack) this.consumePendingBack = true;
        this.releaseGuard();
    }

    /** Wait for existing layers and their guard; never close a remaining layer. */
    navigateWhenLayersDismissed(callback: () => void): void {
        this.queuedNavigation = { callback, url: this.runtime.url() };
        if (this.pendingBack) this.consumePendingBack = true;
        this.releaseGuard();
    }

    private completeNavigation(): void {
        if (this.layers.size || this.pendingBack) return;
        const intent = this.queuedNavigation;
        this.queuedNavigation = null;
        if (
            intent &&
            !this.layers.size &&
            this.runtime.url() === intent.url &&
            !this.isGuard()
        ) {
            intent.callback();
        }
    }

    private releaseGuard(): void {
        if (this.layers.size || this.pendingBack) return;
        if (this.isGuard()) {
            this.pendingBack = true;
            this.consumePendingBack = true;
            this.runtime.back();
        } else {
            // A manual Back already consumed the final layer guard.
            this.completeNavigation();
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
            this.queuedNavigation = null;
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
            // A different route was pushed before our traversal completed:
            // Back landed on the guard, not on the expected base entry.
            if (this.isGuard()) {
                this.queuedNavigation = null;
                this.consumePendingBack = false;
                this.runtime.back();
                return true;
            }
            const consume = this.consumePendingBack;
            this.pendingBack = false;
            if (this.layers.size) this.pushGuard();
            this.completeNavigation();
            return consume;
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
