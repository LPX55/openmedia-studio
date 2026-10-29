# /api/assistant — streaming chat completions proxy

## Responsibility
Proxies LLM chat requests to a BYOK OpenAI-compatible endpoint, kie.ai or Azure
with SSE streaming, so the browser never holds a provider key and non-streamed
upstream bodies are relayed as-is.

## Design
- `export const dynamic = "force-dynamic"`.
- `POST` body: `{ messages?, prompt?, systemPrompt?, systemPromptOverride?,
  model?, azureEndpoint?, azureDeployment?, azureModelName? }`. `messages` wins;
  otherwise a single-turn list is synthesized from `prompt` (+ `systemPrompt` as
  a user/assistant pair).
- **Model resolution** (server fallback): client `model` → the Settings-saved
  assistant default (`getChatCredential().model`, i.e.
  `provider_configs.chat` `extra_json.chatModel` or the `CHAT_MODEL` env
  fallback) → `claude-sonnet-4-6`. The client dropdown sends the model it
  renders; a stale/empty client value cannot desync the two.
- **System prompt**: `systemPromptOverride` (client-sent, from Settings →
  Assistant) replaces the FIRST system message of `messages`; a list without a
  system message gets the built-in default (`lib/systemPrompt.ts`) prepended.
  With no override the caller's own system message is left untouched.
- Three upstream strategies, in order:
  - **BYOK chat credential** (Settings → Assistant): `getChatCredential()` — the
    stored `chat` provider key (else `CHAT_API_KEY`) — is PREFERRED over the
    Kie.ai / Azure credentials. POSTs `{baseUrl ?? "https://api.openai.com/v1"}/chat/completions`
    with `{ model, messages, stream: true }` and `Authorization: Bearer <chatKey>`
    (`azure-auto` maps to `azureModelName` / `"model-router"`). The stored
    `chatPreset` is picker metadata only — the route does not branch on it.
    Without a stored credential the Kie.ai / Azure behaviour below is unchanged.
  - **`azure-auto`** (Azure model-router): normalizes `azureEndpoint` (strips
    trailing `/` and `/openai`), builds
    `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=2024-04-01-preview`,
    sends `stream: true`, `max_tokens: 8192`, `temperature: 0.7`, `top_p: 0.95`,
    auth via `api-key` header (key from `getAzureToken(req)`).
  - **Kie models**: OpenAI-compatible per-model endpoints in
    `OPENAI_COMPAT_ENDPOINTS` (`gemini-3-flash`, `gemini-3.1-pro`, `gpt-5-2` at
    `https://api.kie.ai/{model}/v1/chat/completions`, message content wrapped as
    `[{type:"text",text}]`), otherwise the Anthropic-style
    `POST https://api.kie.ai/claude/v1/messages` with
    `{ model, messages, stream: true, thinkingFlag: true, max_tokens: 4096 }`.
    Auth: Bearer from `getKieToken(req)`.
- Success returns the raw upstream body with SSE headers
  (`text/event-stream`, `no-cache, no-transform`, `X-Accel-Buffering: no`).
- Errors return JSON `{ error }` (Azure envelope unwrapped to `error.message`) with
  the upstream status; missing keys → 401; missing Azure base URL → 400.

## Flow
1. Parse body → build `messages` (400 if neither `messages` nor `prompt`),
   applying the effective system prompt.
2. Resolve the model (client → stored `chatModel` → default).
3. Branch on the stored BYOK chat credential → its endpoint; else
   `model === "azure-auto"` → Azure fetch; else Kie fetch.
4. Relay the upstream body/error unchanged.

## Integration
- **BYOK chat**: `{baseUrl}/chat/completions` (Bearer); credential from
  `lib/guest/db.ts` `getChatCredential()` — `provider_configs` row `chat`
  (`api_key`, `base_url`, `extra_json.chatModel` / `chatPreset`), env fallbacks
  `CHAT_API_KEY` / `CHAT_BASE_URL` / `CHAT_MODEL`. Written by
  `PUT /api/settings/providers` (`chatPreset` / `chatModel` patch).
- **Kie.ai**: `/claude/v1/messages`, `/{model}/v1/chat/completions` (Bearer,
  `lib/getKieToken.ts`).
- **Azure OpenAI**: `{endpoint}/openai/deployments/{d}/chat/completions` (`api-key`,
  `lib/getAzureKey.ts`).
- **Response**: SSE stream (`text/event-stream`) or JSON error; no stores touched.
- **Client**: `app/chat/page.tsx` consumes the stream directly; the model
  dropdown reads its default from `providerStatus.chat.chatModel`
  (`GET /api/settings/providers`). `components/QuickAssist.tsx` and
  `components/nodes/AssistantNode.tsx` are the other callers.
