"use client";

import { Info } from "lucide-react";
import { useState } from "react";
import { ru } from "@/lib/i18n/ru";

/**
 * Renders the KeyboardShortcutsTooltip component.
 */
export function KeyboardShortcutsTooltip() {
    const [isVisible, setIsVisible] = useState(false);

    const shortcuts = [
        { key: "Пробел", action: ru.player.shortcutsList.playPause },
        { key: "→", action: ru.player.shortcutsList.seekForward },
        { key: "←", action: ru.player.shortcutsList.seekBackward },
        { key: "↑", action: ru.player.shortcutsList.volumeUp },
        { key: "↓", action: ru.player.shortcutsList.volumeDown },
        { key: "M", action: ru.player.shortcutsList.toggleMute },
        { key: "N", action: ru.player.shortcutsList.next },
        { key: "P", action: ru.player.shortcutsList.previous },
        { key: "S", action: ru.player.shortcutsList.shuffle },
    ];

    return (
        <div className="relative">
            <button
                onMouseEnter={() => setIsVisible(true)}
                onMouseLeave={() => setIsVisible(false)}
                onClick={() => setIsVisible(!isVisible)}
                className="p-1.5 rounded transition-colors text-gray-400 hover:text-white"
                title={ru.player.shortcuts}
            >
                <Info className="w-3.5 h-3.5" />
            </button>

            {isVisible && (
                <div className="absolute bottom-full right-0 mb-2 w-64 bg-surface-hover border border-white/10 rounded-lg shadow-2xl shadow-black/50 p-4 z-50 backdrop-blur-xl">
                    {/* Pointer arrow */}
                    <div className="absolute -bottom-1 right-3 w-2 h-2 bg-surface-hover border-r border-b border-white/10 rotate-45" />

                    <h3 className="text-white font-bold text-sm mb-3 flex items-center gap-2">
                        <Info className="w-4 h-4" />
                        Keyboard Shortcuts
                    </h3>

                    <div className="space-y-2">
                        {shortcuts.map((shortcut) => (
                            <div
                                key={shortcut.key}
                                className="flex items-center justify-between text-xs"
                            >
                                <span className="text-gray-400">
                                    {shortcut.action}
                                </span>
                                <kbd className="px-2 py-1 bg-white/5 border border-white/10 rounded text-white font-mono text-xs min-w-[40px] text-center">
                                    {shortcut.key}
                                </kbd>
                            </div>
                        ))}
                    </div>

                    <div className="mt-3 pt-3 border-t border-white/10">
                        <p className="text-[10px] text-gray-400 leading-relaxed">
                            Shortcuts work anywhere except when typing in text
                            fields.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
