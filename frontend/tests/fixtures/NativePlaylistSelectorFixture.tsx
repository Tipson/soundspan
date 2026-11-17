import React from "react";
import { createPortal } from "react-dom";
import { Modal } from "../../components/ui/Modal";

/** Exercise the real dialog boundary with a controlled playlist choice. */
export function NativePlaylistSelectorFixture(props: {
    isOpen: boolean;
    onSelectPlaylist: (id: string) => Promise<void>;
}) {
    return props.isOpen
        ? createPortal(
              <Modal isOpen title="QA playlist" onClose={() => undefined}>
                  <button
                      data-testid="choose-qa-playlist"
                      onClick={() => props.onSelectPlaylist("qa-playlist")}
                  >
                      QA playlist
                  </button>
              </Modal>,
              document.body,
          )
        : null;
}
