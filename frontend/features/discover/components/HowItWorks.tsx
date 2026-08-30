"use client";

import { Sparkles, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { discoverRu } from "@/lib/i18n/discoverRu";

/**
 * Renders the HowItWorks component.
 */
export function HowItWorks() {
    return (
        <Card className="p-6 bg-[#111]/50  border-white/5">
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2 text-white">
                <Sparkles className="w-5 h-5 text-ai-hover" />
                {discoverRu.howItWorks.title}
            </h3>
            <div className="space-y-3 text-sm text-gray-400">
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-ai-hover/60 shrink-0" />
                    <p>{discoverRu.howItWorks.history}</p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-ai-hover/60 shrink-0" />
                    <p>{discoverRu.howItWorks.variety}</p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-ai-hover/60 shrink-0" />
                    <p>{discoverRu.howItWorks.providers}</p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-ai-hover/60 shrink-0" />
                    <p>{discoverRu.howItWorks.badges}</p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-ai-hover/60 shrink-0" />
                    <p>{discoverRu.howItWorks.repeats}</p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-ai-hover/60 shrink-0" />
                    <p>{discoverRu.howItWorks.noWrites}</p>
                </div>
            </div>
        </Card>
    );
}
