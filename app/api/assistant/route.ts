export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { getKieToken } from "@/lib/getKieToken";
import { getAzureToken } from "@/lib/getAzureKey";
import { getChatCredential } from "@/lib/guest/db";
import { SYSTEM_PROMPT } from "@/lib/systemPrompt";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

// Models that use OpenAI-compatible chat/completions endpoint
const OPENAI_COMPAT_ENDPOINTS: Record<string, string> = {
  "gemini-3-flash":  "https://api.kie.ai/gemini-3-flash/v1/chat/completions",
  "gemini-3.1-pro":  "https://api.kie.ai/gemini-3.1-pro/v1/chat/completions",
  "gpt-5-2":         "https://api.kie.ai/gpt-5-2/v1/chat/completions",
};

const AZURE_API_VERSION = "2024-04-01-preview";

/**
 * The system prompt actually used for a request: the client may override the
 * built-in default (lib/systemPrompt.ts) via `systemPromptOverride`; an empty
 * override falls back to the default.
 */
function resolveSystemPrompt(override: unknown): string | null {
  const custom = typeof override === "string" ? override.trim() : "";
  return custom || null;
}

/**
 * Apply the effective system prompt to a message list: the FIRST system
 * message is rewritten, or one is prepended when the list has none.
 *
 * With no override the caller's own system message is kept as-is; only a
 * message list WITHOUT a system message gets the built-in default.
 */
function applySystemPrompt(messages: Message[], systemPrompt: string | null): Message[] {
  const idx = messages.findIndex((m) => m.role === "system");
  if (idx === -1) {
    return [{ role: "system", content: systemPrompt ?? SYSTEM_PROMPT }, ...messages];
  }
  if (systemPrompt === null) return messages;
  return messages.map((m, i) => (i === idx ? { ...m, content: systemPrompt } : m));
}

/** Default base URL of the BYOK chat endpoint (an OpenAI-compatible API). */
const DEFAULT_CHAT_BASE_URL = "https://api.openai.com/v1";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    messages?: Message[];
    prompt?: string;
    systemPrompt?: string;
    systemPromptOverride?: string;
    model?: string;
    azureEndpoint?: string;
    azureDeployment?: string;
    azureModelName?: string;
  };

  const model = body.model ?? "claude-sonnet-4-6";
  const systemPrompt = resolveSystemPrompt(body.systemPromptOverride);

  let messages: Message[];

  if (body.messages && body.messages.length > 0) {
    messages = applySystemPrompt(body.messages, systemPrompt);
  } else if (body.prompt?.trim()) {
    messages = [];
    if (body.systemPrompt?.trim()) {
      messages.push({ role: "user", content: body.systemPrompt.trim() });
      messages.push({ role: "assistant", content: "Understood." });
    }
    messages.push({ role: "user", content: body.prompt.trim() });
  } else {
    return new Response(JSON.stringify({ error: "messages or prompt is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── BYOK chat credential (Settings → Assistant) ────────────────────────────
  // When the user stored their OWN chat credential, it is PREFERRED over the
  // Kie.ai / Azure credentials (it may point at any OpenAI-compatible endpoint
  // via its base URL). Without it, the Kie.ai / Azure behaviour below is
  // completely unchanged.
  const chatCred = getChatCredential();
  if (chatCred.apiKey) {
    const base = (chatCred.baseUrl ?? DEFAULT_CHAT_BASE_URL).replace(/\/+$/, "");
    // `azure-auto` is an Azure model-router name; for an OpenAI-compatible
    // endpoint the configured Azure model name is the closer match.
    const chatModel =
      model === "azure-auto" ? (body.azureModelName?.trim() || "model-router") : model;
    const upstream = await fetch(`${base}/chat/completions`, {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${chatCred.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: chatModel,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      }),
    });
    if (!upstream.ok) {
      const errText = await upstream.text();
      return new Response(JSON.stringify({ error: errText }), {
        status: upstream.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(upstream.body, {
      headers: {
        "Content-Type":      "text/event-stream",
        "Cache-Control":     "no-cache, no-transform",
        "Connection":        "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // ── Azure Auto (model-router) ──────────────────────────────────────────────
  if (model === "azure-auto") {
    const azureKey = await getAzureToken(req);
    if (!azureKey) {
      return new Response(
        JSON.stringify({ error: "No Azure API key configured. Add one in Settings." }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    // Normalise: strip trailing slashes and any /openai suffix users may have pasted
    const endpoint = (body.azureEndpoint ?? "")
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/openai$/i, "");
    const deployment  = (body.azureDeployment || "auto-model").trim();
    const modelName   = (body.azureModelName  || "model-router").trim();
    if (!endpoint) {
      return new Response(
        JSON.stringify({ error: "Azure base URL not configured. Add it in Settings → API Keys." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${AZURE_API_VERSION}`;
    console.log("[azure-auto] POST", url.replace(/api-version=.*/, "api-version=…"));
    const upstream = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "api-key": azureKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName,
        messages,
        stream: true,
        max_tokens: 8192,
        temperature: 0.7,
        top_p: 0.95,
        frequency_penalty: 0,
        presence_penalty: 0,
      }),
    });
    if (!upstream.ok) {
      const errText = await upstream.text();
      // Extract human-readable message from Azure error envelope
      let errorMsg = errText;
      try {
        const parsed = JSON.parse(errText);
        errorMsg = parsed?.error?.message ?? parsed?.message ?? errText;
      } catch { /* use raw text */ }
      console.error("[azure-auto] upstream error", upstream.status, errorMsg);
      return new Response(
        JSON.stringify({ error: `Azure ${upstream.status}: ${errorMsg}` }),
        { status: upstream.status, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(upstream.body, {
      headers: {
        "Content-Type":      "text/event-stream",
        "Cache-Control":     "no-cache, no-transform",
        "Connection":        "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // ── Kie.ai models ─────────────────────────────────────────────────────────
  const apiKey = await getKieToken(req);
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "No API key configured for this provider. Add one in Settings." }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const openaiEndpoint = OPENAI_COMPAT_ENDPOINTS[model];

  const upstream = openaiEndpoint
    ? await fetch(openaiEndpoint, {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: messages.map(m => ({
            role: m.role,
            content: [{ type: "text", text: m.content }],
          })),
          stream: true,
        }),
      })
    : await fetch("https://api.kie.ai/claude/v1/messages", {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          thinkingFlag: true,
          max_tokens: 4096,
        }),
      });

  if (!upstream.ok) {
    const errText = await upstream.text();
    return new Response(JSON.stringify({ error: errText }), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type":       "text/event-stream",
      "Cache-Control":      "no-cache, no-transform",
      "Connection":         "keep-alive",
      "X-Accel-Buffering":  "no",
    },
  });
}
