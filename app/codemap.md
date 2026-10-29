# app/ (root)

## Responsibility
Root App Router shell: global layout chrome (sidebar shell, fonts, banners, modals), the `/` route redirect, and the global stylesheet. Files covered: `layout.tsx`, `page.tsx`, `globals.css`, `favicon.ico`.

## Design
- `RootLayout` (async Server Component) composes the provider stack: `TooltipProvider` → `SidebarProvider` → `AppSidebar` + `SidebarInset`, with `GlobalModals` outside the sidebar tree (fixed-position modals must escape the inset overflow).
- Sidebar default open state is cookie-driven (`sidebar_state` via `next/headers.cookies()`), read server-side so the shell paints without a client hydration flip.
- Google fonts (`Geist`, `Geist_Mono`, `Doto` weight 900) loaded via `next/font/google`, exposed as CSS variables `--font-geist-sans`, `--font-geist-mono`, `--font-doto` on `<html>`.
- Metadata: title `OpenMedia Studio`, description "Build AI image & video generation workflows visually", favicon from `/mark.svg` (`icon` + `shortcut`).
- Viewport locked (`maximumScale: 1`) and `overflow-hidden` body — app-canvas UX, not a scrolling document.
- `globals.css` (Tailwind v4 `@import "tailwindcss"`) is the design system for the React Flow canvas: `.node-card` / `.node-header` / `.node-input` primitives, dot and icon handle variants (`.node-handle`, `.node-handle-icon`) with role-typed color classes (`-prompt`, `-image`, `-resource`, `-videoref`, `-refvideo`, `-audioref`, `-character`, `-out-*`), plus state classes (`node-generating`, `node-queued`, `node-error-blink`, `node-over-limit`, `node-ancestor`, `node-group-preview`, `node-dying`).
- Connection-type compatibility filtering is CSS-driven via `data-connecting-type` attribute set by JS `onConnectStart` on `.react-flow` (see rules at `.react-flow[data-connecting-type="…"]`).
- Other CSS systems: `@mention` chip (`.mention-chip`), marquee/selection rect, hand-mode cursor, generating conic-gradient border, upload shimmer, lightbox blur-pulse, toolbar buttons.

## Flow
1. Request `/` → `Home` in `page.tsx` calls `redirect("/gallery?tab=images")` (server-side Next redirect).
2. Any nested route renders inside `RootLayout`: server reads `sidebar_state` cookie → `SidebarProvider defaultOpen` → mounts `AppSidebar`, `KieBanner`, `UpdateBanner`, mobile `SidebarTrigger` bar, `DragDropGuard`, then `{children}` inside `SidebarInset`; `GlobalModals` mounts once at `<body>` end.
3. `globals.css` styles apply to all client canvas components (React Flow overrides target `.react-flow__*` classes).

## Integration
- Depends on: `@/components/AppSidebar`, `@/components/GlobalModals`, `@/components/KieBanner`, `@/components/UpdateBanner`, `@/components/DragDropGuard`, `@/components/ui/sidebar` (`SidebarProvider`/`SidebarInset`/`SidebarTrigger`), `@/components/ui/tooltip` (`TooltipProvider`), `next/headers` (`cookies`), `next/font/google`.
- Consumed by: every route in `app/` (chat, gallery, generated, workflow, workflow/[id]) as the shared document shell.
- `globals.css` is consumed by all node/handle/edge components on the workflow canvas; class names (`.node-card`, `.node-handle-*`, `data-connecting-type`) are a public contract with those components.
- `page.tsx` redirects `/` → `/gallery?tab=images`, making gallery the de-facto landing route.
