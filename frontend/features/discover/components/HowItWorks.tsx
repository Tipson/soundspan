"use client";

import { Sparkles, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { discoverRu } from "@/lib/i18n/discoverRu";

/**
 * Renders the HowItWorks component.
 */
export function HowItWorks() {
    return (
        <Card className="rounded-2xl border-line bg-surface-elevated p-5 sm:p-6">
            <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-content">
                <Sparkles className="size-5 text-ai-hover" aria-hidden="true" />
                {discoverRu.howItWorks.title}
            </h3>
            <div className="grid gap-3 text-sm leading-6 text-content-muted md:grid-cols-2">
                <div className="flex items-start gap-3">
                    <ChevronRight className="mt-1 size-4 shrink-0 text-ai-hover/70" />
                    <p>{discoverRu.howItWorks.history}</p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="mt-1 size-4 shrink-0 text-ai-hover/70" />
                    <p>{discoverRu.howItWorks.variety}</p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="mt-1 size-4 shrink-0 text-ai-hover/70" />
                    <p>{discoverRu.howItWorks.providers}</p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="mt-1 size-4 shrink-0 text-ai-hover/70" />
                    <p>{discoverRu.howItWorks.badges}</p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="mt-1 size-4 shrink-0 text-ai-hover/70" />
                    <p>{discoverRu.howItWorks.repeats}</p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="mt-1 size-4 shrink-0 text-ai-hover/70" />
                    <p>{discoverRu.howItWorks.noWrites}</p>
                </div>
            </div>
        </Card>
    );
}
