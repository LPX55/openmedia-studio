# app/chat/codemap.md

Covers `app/chat/page.tsx`.

## Responsibility
Client-side AI prompt-assistant chat UI at `/chat` (query param `?id=<sessionId>` selects an active session). Streams LLM completions from `POST /api/assistant` and persists sessions locally via a Zustand store. No server rendering of chat content.

## Design
- Page structure: `ChatPage` (client) wraps `ChatInner` in `Suspense` because it calls `useSearchParams`.
- `ChatInner` gates rendering on Zustand persist hydration (`useChatSessionStore.persist.onFinishHydration`), showing "Loading…" until true.
- View split: no `?id` → `LandingView` (logo + `TypewriterHeading` + animated cycling placeholder + model picker); `?id` matching a stored session → `ChatWindow` keyed by `activeSession.id` to reset internal state per session.
- Internal subcomponents: `LogoIcon`, `ModelPicker` (dropdown grouped by `MODEL_GROUPS`, disables `azure-auto` when `azureKeySet !== true`), `useCyclingPlaceholder` (typing/waiting/deleting state machine over `PLACEHOLDER_SENTENCES`).
- Styling is inline `style={{}}` objects (no Tailwind classes for layout); teal accent `rgba(45,212,191,…)` matches the app accent.
- Model gating reads `kieKeySet` / `azureKeySet` from `useWorkflowStore`; send button disabled when Kie key missing or model not configured.

## Flow
**Send message (`ChatWindow.send`):**
1. Guard: empty input / `isStreaming` / `onAuthRequired` → abort (auth hook unused by current parent, but placeholder for gating).
2. Build `contextMessages = [...session.messages, {role:"user", content}]`; compute `assistantIdx` before mutation.
3. `flushSync` batch: append user + empty streaming-assistant bubble, clear input, set `isStreaming`.
4. `onUpdate(contextMessages, model)` → parent persists via `upsertSession`.
5. `getToken()` (from `@/lib/galleryUtils`) → optional `Authorization: Bearer`.
6. If `model === "azure-auto"`, load Azure config (`loadAzureBaseUrl`, `loadAzureTextDeployment`, `loadAzureTextModelName` from `SettingsModal`).
7. `fetch("/api/assistant", {body: {model, messages: [SYSTEM_PROMPT, …contextMessages], stream: true, …azureConfig}, signal: abort.signal})`.
8. Read `res.body` via `ReadableStreamDefaultReader` + `TextDecoder`; split on `\n`, parse `data: ` SSE lines; handle both Anthropic-style `content_block_delta` and OpenAI-style `choices[0].delta.content`.
9. One `setMessages` per network read (paint-friendly); on `[DONE]`/done, finalize `finalMessages` and call `onUpdate(finalMessages, model)`.
10. `catch`: non-`AbortError` → replace assistant content with "Request failed."; `finally` clears `isStreaming`.

**Landing submit (`handleLandingSubmit`):** `createSession(landingModel, text.slice(0,50))` → store id → `setPendingMessage(text)` → `router.push("/chat?id=" + id)`; the mounted `ChatWindow` auto-sends `initialMessage` once via `hasSentInitial` ref.

## Integration
- Depends on: `@/lib/chatSessionStore` (`useChatSessionStore`, `StoredMessage`, `ChatSession` — persistence + CRUD), `@/lib/galleryUtils` (`getToken`), `@/lib/models` (`MODEL_GROUPS`, `MODELS`, `ModelId`), `@/lib/systemPrompt` (`SYSTEM_PROMPT`), `@/lib/store` (`useWorkflowStore` — `kieKeySet`, `azureKeySet`), `@/components/SettingsModal` (Azure loader fns), `@/components/ui/DotCanvasBackground`, `@/components/ui/TypewriterHeading`, `next/navigation` (`useRouter`, `useSearchParams`), `motion/react`, `lucide-react`, `next/image`.
- Depends on API: `POST /api/assistant` (SSE stream, Anthropic/OpenAI delta shapes).
- Consumed by: routed via `app/layout.tsx` shell; navigated to from other pages (e.g. prompt-assist entry) pushing `/chat?id=…`.
