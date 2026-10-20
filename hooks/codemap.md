# hooks/

Shared React client hooks for the web UI.

## Responsibility

Reusable stateful React logic separated from components. Currently contains a single hook:

- `use-mobile.ts` — `useIsMobile()`: boolean viewport-width query (`< 768px`).

## Design

- `useIsMobile()` initializes to `undefined` (SSR-safe) and resolves in a `useEffect` via `window.matchMedia("(max-width: 767px)")` + `innerWidth` check. Returns coerced `!!isMobile`, so callers get a definite `false` before hydration instead of `undefined`.
- Single breakpoint constant `MOBILE_BREAKPOINT = 768` kept module-local.
- No external deps; pure React. The `matchMedia` "change" listener is attached/detached with the effect for live reactivity on resize.

## Flow

Call site mounts → state `undefined` → effect runs → sets initial boolean and subscribes to media-query changes → updates on resize → cleanup on unmount.

## Integration

- Consumed by `components/ui/sidebar.tsx` (shadcn sidebar) to switch between desktop and mobile sidebar rendering (`Sheet` on mobile).
- Path alias `@/hooks/*` via `tsconfig`. Pure client code — do not call from server components.
