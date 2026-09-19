# Main-content scroll restoration

The desktop and mobile application shells scroll an inner `main` element rather
than the browser window. `MainScrollRestoration` adapts committed Next.js pathname
and query changes to `useMainScrollRestoration` for that element.

- Back/forward restores the last recorded position for the destination route.
- A history traversal schedules its own render. Restoration works whether the
  router commits the pathname before or after the application's event listener.
- Ordinary navigation retains the router's behavior; background renders do not
  move the page.
- The hook ignores the outgoing page's automatic reset after the URL changes.
- Up to 50 pathname/query positions are retained in the mounted account shell.
  Repeated visits to one URL share its latest position. Nothing is written into
  browser history, local storage, server history, or taste profiles.
- The adapter is keyed by account identity. Unmounting the shell clears its
  positions and event subscriptions.
- A pending restoration waits at most two seconds of elapsed time for content
  height, and stops on wheel, touch, pointer, or keyboard input. Unmount and a
  subsequent route commit cancel scheduled animation frames.
- Library tabs reveal clipped horizontal edges using their own `scrollLeft`;
  they do not call `scrollIntoView` on a page ancestor.

The hook's behavioral component tests cover back/forward, query routes, router
resets, both history-listener orders, unchanged rerenders, delayed content, manual cancellation, the deadline,
and account-shell isolation. Test placement includes a separate driver before
the referenced main element, matching the mobile shell's ref-attachment timing.

This behavior does not persist across reloads or replace platform-specific
background-playback testing. Inner queue panels with separate scroll elements
are outside the main-content hook's ownership.
