"use client";

import DOMPurify from "dompurify";
import { Card } from "@/components/ui/Card";

interface AboutSectionProps {
    description: string;
}

/**
 * Renders the AboutSection component.
 */
export function AboutSection({ description }: AboutSectionProps) {
    // Skip if description is just narrator info
    if (description.match(/^(Read by|Narrated by):/i)) {
        return null;
    }

    return (
        <section>
            <h2 className="mb-4 text-xl font-semibold text-content sm:text-2xl">
                О книге
            </h2>
            <Card className="rounded-[14px] p-4 sm:p-5">
                <div
                    className="prose prose-invert prose-sm max-w-[70ch] text-sm leading-7 text-content-secondary [overflow-wrap:anywhere]"
                    dangerouslySetInnerHTML={{
                        __html: DOMPurify.sanitize(description || ""),
                    }}
                />
            </Card>
        </section>
    );
}
