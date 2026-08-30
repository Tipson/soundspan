"use client";

import { useState, useRef } from "react";
import { Search as SearchIcon } from "lucide-react";
import { useIsTV } from "@/lib/tv-utils";
import { searchExtrasRu } from "@/lib/i18n/searchExtrasRu";

interface TVSearchInputProps {
    initialQuery?: string;
    onSearch: (query: string) => void;
}

/**
 * Renders the TVSearchInput component.
 */
export function TVSearchInput({
    initialQuery = "",
    onSearch,
}: TVSearchInputProps) {
    const isTV = useIsTV();
    const inputRef = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState(initialQuery);
    const [isFocused, setIsFocused] = useState(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (query.trim()) {
            onSearch(query.trim());
            // Blur the input after search to return to D-pad navigation
            inputRef.current?.blur();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        // On Enter, submit the search
        if (e.key === "Enter") {
            handleSubmit(e);
        }
        // On Escape, blur the input
        if (e.key === "Escape") {
            inputRef.current?.blur();
        }
    };

    // Only render this component in TV mode
    if (!isTV) {
        return null;
    }

    return (
        <div className="mb-7" data-tv-section="tv-search">
            <form onSubmit={handleSubmit}>
                <div className="relative max-w-2xl">
                    <label htmlFor="tv-search-input" className="sr-only">
                        {searchExtrasRu.tvSearch.label}
                    </label>
                    <SearchIcon
                        aria-hidden="true"
                        className="pointer-events-none absolute left-5 top-1/2 h-6 w-6 -translate-y-1/2 text-content-muted"
                    />
                    <input
                        id="tv-search-input"
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onFocus={() => setIsFocused(true)}
                        onBlur={() => setIsFocused(false)}
                        placeholder={searchExtrasRu.tvSearch.placeholder}
                        autoCapitalize="none"
                        autoCorrect="off"
                        autoComplete="off"
                        data-tv-card
                        data-tv-card-index={0}
                        tabIndex={0}
                        className={`h-16 w-full rounded-2xl border-2 bg-white/[0.045] pl-14 pr-44 text-xl text-content outline-none transition duration-200 placeholder:text-content-muted hover:bg-white/[0.065] focus-visible:ring-2 focus-visible:ring-brand-light/40 motion-reduce:transition-none ${
                            isFocused
                                ? "border-brand bg-white/[0.07]"
                                : "border-white/[0.08]"
                        }`}
                    />
                    {query && (
                        <div className="pointer-events-none absolute right-5 top-1/2 -translate-y-1/2 text-sm text-content-secondary">
                            {searchExtrasRu.tvSearch.hint}
                        </div>
                    )}
                </div>
            </form>
        </div>
    );
}
