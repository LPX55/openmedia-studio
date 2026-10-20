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
  a user/assistant pair). Default model: `claude-sonnet-4-6`.
- **System prompt**: `systemPromptOverride` (client-sent, from Settings →
  Assistant) replaces the FIRST system message of `messages`; a list without a
  system message gets the built-in default (`lib/systemPrompt.ts`) prepended.
  With no override the caller's own system message is left untouched.
- Three upstream strategies, in order:
  - **BYOK chat credential** (Settings → Assistant): the stored `chat` provider
    credential (`getChatCredential()` — stored key, else `CHAT_API_KEY` env
    fallback) is PREFERRED over the Kie.ai / Azure credentials. POSTs
    `{baseUrl ?? "https://api.openai.com/v1"}/chat/completions` with
    `{ model, messages, stream: true }` and `Authorization: Bearer <chatKey>`
    (`azure-auto` maps to the configured Azure model name). Without a stored
    credential the Kie.ai / Azure behaviour below is unchanged.
  - **`azure-auto`** (Azure model-router): normalizes `azureEndpoint` (strips
    trailing `/` and `/openai`), builds
    `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=2024-04-01-preview`,
    sends `stream: true`, `max_tokens: 8192`, `temperature: 0.7`, `top_p: 0.95`,
    auth via `api-key` header (key from `getAzureToken(req)`).
  - **Kie models**: OpenAI-compatible per-model endpoints in
    `OPENAI_COMPAT_ENDPOINTS` (`gemini-3-flash`, `gemini-3.1-pro`, `gpt-5-2` at
    `https://api.kie.ai/{model}/v1/chat/completions`, messages content wrapped as
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
2. Branch on the stored BYOK chat credential → its endpoint; else
   `model === "azure-auto"` → Azure fetch; else Kie fetch.
3. Relay upstream body/error.

## Integration
- **BYOK chat**: `{baseUrl}/chat/completions` (Bearer, `lib/guest/db.ts`
  `getChatCredential()`; stored in `provider_configs` under the `chat` id).
- **Kie.ai**: `/claude/v1/messages`, `/{model}/v1/chat/completions` (Bearer, `lib/getKieToken.ts`).
- **Azure OpenAI**: `{endpoint}/openai/deployments/{d}/chat/completions` (`api-key`, `lib/getAzureKey.ts`).
- **Response**: SSE stream (`text/event-stream`) or JSON error; no stores touched.
