"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { IMAGE_MODELS, VIDEO_MODELS } from "@/lib/modelConfig";
import { MODEL_GROUPS } from "@/lib/models";
import { useWorkflowStore } from "@/lib/store";
import { PROVIDERS, ProviderId, providerMeta, loadModelProviders, saveModelProviders, getModelProvider, getAzureDeployments, getAzureBaseUrl, refreshProviderBootstrap, enabledProvidersForModel } from "@/lib/providers";
import { ProviderBrandIcon } from "@/components/ui/ProviderIcon";

/* ─── Provider options (re-exported for backwards compat) ───────────────────── */

export { PROVIDERS, loadModelProviders, saveModelProviders, getModelProvider };
export type { ProviderId };

export type CodexStatus =
  | { kind: "unknown" }
  | { kind: "ready" }
  | { kind: "not_ready"; installed: boolean; authFound: boolean };

/* ─── Persistence ───────────────────────────────────────────────────────────── */

// Phase 5 (C2/C8, design §3.3-§3.4): the Azure base URL + per-model deployment
// map are SERVER-AUTHORITATIVE (provider_configs via PUT /api/settings/providers).
// The legacy localStorage keys (`aiui-azure-base-url` / `aiui-azure-endpoints`)
// are gone; these loaders keep their old names for chat/QuickAssist, now
// reading the store that GET /api/settings/providers hydrates.
const AZURE_TEXT_DEPLOY_KEY  = "aiui-azure-text-deployment"; // text model deployment (URL path)
const AZURE_TEXT_MODEL_KEY   = "aiui-azure-text-model";      // text model name (request body)

/** Per-model deployment name map (e.g. { "gpt-image-2": "gpt-image-2" }). */
export function loadAzureEndpoints(): Record<string, string> {
  return getAzureDeployments();
}

export function saveAzureEndpoints(map: Record<string, string>) {
  scheduleAzurePut({ deployments: map });
}

/** Returns the deployment name for a given model, or "" if unset. */
export function getAzureDeployment(modelId: string): string {
  return getAzureDeployments()[modelId] ?? "";
}

/** Global Azure Foundry base URL (shared across all models). */
export function loadAzureBaseUrl(): string {
  return getAzureBaseUrl();
}

export function saveAzureBaseUrl(url: string) {
  scheduleAzurePut({ baseUrl: url });
}

/** Debounced PUT-through (the base-URL/deployment editors are per-keystroke). */
let azurePutTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAzurePut(body: { baseUrl?: string; deployments?: Record<string, string> }) {
  if (azurePutTimer) clearTimeout(azurePutTimer);
  azurePutTimer = setTimeout(() => {
    azurePutTimer = null;
    void (async () => {
      try {
        await fetch("/api/settings/providers", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerId: "azure", ...body }),
        });
        // Re-hydrate so readiness gates + the editors see the new value.
        await refreshProviderBootstrap();
      } catch { /* offline — local editor state keeps the draft */ }
    })();
  }, 400);
}

/** @deprecated renamed — use getAzureDeployment(). Kept for backwards compat. */
export const getAzureEndpoint = getAzureDeployment;

/** Deployment name — used in the URL path (defaults to "auto-model"). */
export function loadAzureTextDeployment(): string {
  try {
    return localStorage.getItem(AZURE_TEXT_DEPLOY_KEY) ?? "auto-model";
  } catch {
    return "auto-model";
  }
}

export function saveAzureTextDeployment(name: string) {
  try {
    localStorage.setItem(AZURE_TEXT_DEPLOY_KEY, name);
  } catch { /* noop */ }
}

/** Model name — passed in the request body (defaults to "model-router"). */
export function loadAzureTextModelName(): string {
  try {
    return localStorage.getItem(AZURE_TEXT_MODEL_KEY) ?? "model-router";
  } catch {
    return "model-router";
  }
}

export function saveAzureTextModelName(name: string) {
  try {
    localStorage.setItem(AZURE_TEXT_MODEL_KEY, name);
  } catch { /* noop */ }
}

/* ─── Nav items ─────────────────────────────────────────────────────────────── */

const IS_DEBUG = process.env.NEXT_PUBLIC_DEBUG === "true";

type NavId = "api-keys" | "image-models" | "video-models" | "text-models" | "assistant" | "debug";

const NAV_BASE: { id: NavId; label: string; icon: React.ReactNode }[] = [
  {
    id: "api-keys",
    label: "API Keys",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="15" r="4" />
        <path d="m11.31 11.31 5.19-5.19" />
        <path d="m17 5 1.5 1.5" />
        <path d="m14 8 1.5 1.5" />
      </svg>
    ),
  },
  {
    id: "image-models",
    label: "Image Models",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" />
      </svg>
    ),
  },
  {
    id: "video-models",
    label: "Video Models",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="m22 8-6 4 6 4V8z" />
        <rect x="2" y="6" width="14" height="12" rx="2" />
      </svg>
    ),
  },
  {
    id: "text-models",
    label: "Text Models",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    id: "assistant",
    label: "Assistant",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 8V4H8" />
        <rect width="16" height="12" x="4" y="8" rx="2" />
        <path d="M2 14h2M20 14h2M9 13v2M15 13v2" />
      </svg>
    ),
  },
];

const DEBUG_NAV_ITEM: { id: NavId; label: string; icon: React.ReactNode } = {
  id: "debug",
  label: "Debug",
  icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  ),
};

const NAV = IS_DEBUG ? [...NAV_BASE, DEBUG_NAV_ITEM] : NAV_BASE;

/* ─── Props ─────────────────────────────────────────────────────────────────── */

interface SettingsModalProps {
  onClose: () => void;
}

/* ─── Toggle ─────────────────────────────────────────────────────────────────── */

function ProviderToggle({
  modelId,
  value,
  onChange,
  providers,
}: {
  modelId: string;
  value: ProviderId;
  onChange: (v: ProviderId) => void;
  /** The model's provider union from GET bindingsByModel (falls back to all three pre-hydration). */
  providers: ProviderId[];
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        background: "rgba(255,255,255,0.04)",
        borderRadius: "8px",
        padding: "3px",
        gap: "2px",
        border: "1px solid rgba(255,255,255,0.07)",
        flexShrink: 0,
      }}
    >
      {(providers.length >= 2 ? providers : PROVIDERS.map((p) => p.id)).map((id) => {
        // `providers` is the SERVER's per-model union — it may name a backend
        // this bundle doesn't know (another compat alias). `providerMeta()`
        // degrades to the raw id instead of the old `find(...)!` crash.
        const p = providerMeta(id);
        const active = value === p.id;
        return (
          <button
            key={p.id}
            id={`provider-${modelId}-${p.id}`}
            onClick={() => onChange(p.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "5px",
              padding: "4px 10px",
              borderRadius: "6px",
              border: "none",
              cursor: "pointer",
              fontSize: "11px",
              fontWeight: 500,
              letterSpacing: "0.01em",
              transition: "background 140ms ease, color 140ms ease",
              background: active ? "rgba(255,255,255,0.1)" : "transparent",
              color: active ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.32)",
              whiteSpace: "nowrap",
            }}
          >
            <ProviderBrandIcon id={p.id} />
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

/* ─── Model row ─────────────────────────────────────────────────────────────── */

function ModelRow({
  id,
  name,
  providerLabel,
  category,
  value,
  onChange,
  choices,
  hidden,
  onToggleHidden,
}: {
  id: string;
  name: string;
  providerLabel: string;
  category: string;
  value: ProviderId;
  onChange: (v: ProviderId) => void;
  /** Providers this model can run on — toggle only when ≥2 (any image OR video model). */
  choices: ProviderId[];
  /** The model is hidden from every picker (declutter). */
  hidden: boolean;
  onToggleHidden: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "14px",
        padding: "11px 16px",
        borderRadius: "10px",
        background: hidden ? "rgba(255,255,255,0.01)" : "rgba(255,255,255,0.02)",
        border: `1px solid ${hidden ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.05)"}`,
        opacity: hidden ? 0.5 : 1,
      }}
    >
      {/* Labels */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "13px",
            fontWeight: 500,
            color: "rgba(255,255,255,0.85)",
            lineHeight: 1.3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
          {hidden && (
            <span
              style={{
                marginLeft: "8px",
                fontSize: "9px",
                fontWeight: 600,
                letterSpacing: "0.06em",
                color: "rgba(251,146,60,0.8)",
                background: "rgba(251,146,60,0.1)",
                border: "1px solid rgba(251,146,60,0.2)",
                borderRadius: "4px",
                padding: "1px 5px",
                verticalAlign: "middle",
              }}
            >
              HIDDEN
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: "11px",
            color: "rgba(255,255,255,0.28)",
            marginTop: "2px",
          }}
        >
          {providerLabel} · {category}
        </div>
      </div>

      {/* Provider toggle — any model (image OR video) with ≥2 bound backends (P5 C7) */}
      {choices.length >= 2 && <ProviderToggle modelId={id} value={value} onChange={onChange} providers={choices} />}

      {/* Visibility toggle — hide a model from every picker */}
      <button
        id={`model-visibility-${id}`}
        onClick={onToggleHidden}
        title={hidden ? "Show this model in the pickers" : "Hide this model from the pickers"}
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: "5px",
          padding: "5px 9px",
          borderRadius: "7px",
          border: "1px solid rgba(255,255,255,0.1)",
          background: "rgba(255,255,255,0.04)",
          color: hidden ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.6)",
          cursor: "pointer",
          fontSize: "10px",
          fontWeight: 500,
          letterSpacing: "0.04em",
          whiteSpace: "nowrap",
        }}
      >
        {hidden ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 2l20 20" />
            <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
            <path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.2 3.2M6.6 6.6A18.5 18.5 0 0 0 2 12s3 8 10 8a9.8 9.8 0 0 0 5.4-1.6" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
        {hidden ? "Show" : "Hide"}
      </button>
    </div>
  );
}

/* ─── Section group ─────────────────────────────────────────────────────────── */

function ModelGroup({
  title,
  accent,
  models,
  providers,
  onProviderChange,
  azureDeployments,
  onDeploymentChange,
}: {
  title: string;
  accent: string;
  models: { id: string; name: string; provider: string; category: string; hasAzureDeployment?: boolean }[];
  providers: Record<string, ProviderId>;
  onProviderChange: (modelId: string, v: ProviderId) => void;
  azureDeployments: Record<string, string>;
  onDeploymentChange: (modelId: string, v: string) => void;
}) {
  // P5 C7: the toggle set comes from the server's per-model provider union
  // (bindingsByModel); availableProvidersForModel() falls back to the static
  // set pre-hydration. The subscription makes the row re-render when GET lands.
  useWorkflowStore((s) => s.bindingsByModel);
  // Visibility toggles (declutter) — the row re-renders when a model is hidden.
  const disabledModels = useWorkflowStore((s) => s.disabledModels);
  const disabledProviders = useWorkflowStore((s) => s.disabledProviders);
  const setModelEnabled = useWorkflowStore((s) => s.setModelEnabled);
  return (
    <div>
      {/* Group header */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
        <span style={{ display: "inline-block", width: "6px", height: "6px", borderRadius: "50%", background: accent, flexShrink: 0 }} />
        <span style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.08em", color: "rgba(255,255,255,0.35)", textTransform: "uppercase" }}>
          {title}
        </span>
      </div>

      {/* Rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {models.map((m) => (
          <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <ModelRow
              id={m.id}
              name={m.name}
              providerLabel={m.provider}
              category={m.category}
              value={providers[m.id] ?? "kie"}
              onChange={(v) => onProviderChange(m.id, v)}
              choices={enabledProvidersForModel(m.id, disabledProviders, providers[m.id])}
              hidden={disabledModels.includes(m.id)}
              onToggleHidden={() => setModelEnabled(m.id, disabledModels.includes(m.id))}
            />
            {/* Deployment name — shown only for Azure-capable models when Azure is selected */}
            {m.hasAzureDeployment && (providers[m.id] ?? "kie") === "azure" && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  padding: "10px 14px",
                  background: "rgba(96,165,250,0.04)",
                  border: "1px solid rgba(96,165,250,0.12)",
                  borderRadius: "10px",
                }}
              >
                <label
                  htmlFor={`azure-deploy-${m.id}`}
                  style={{ fontSize: "11px", fontWeight: 600, color: "rgba(96,165,250,0.7)", letterSpacing: "0.05em", textTransform: "uppercase" }}
                >
                  Deployment Name
                </label>
                <input
                  id={`azure-deploy-${m.id}`}
                  type="text"
                  placeholder={`e.g. ${m.id}`}
                  value={azureDeployments[m.id] ?? ""}
                  onChange={(e) => onDeploymentChange(m.id, e.target.value)}
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: "7px",
                    padding: "7px 11px",
                    fontSize: "12px",
                    color: "rgba(255,255,255,0.8)",
                    outline: "none",
                    fontFamily: "inherit",
                    fontFeatureSettings: "\"tnum\"",
                  }}
                  onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = "rgba(96,165,250,0.4)"; }}
                  onBlur={(e)  => { (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.08)"; }}
                />
                <p style={{ fontSize: "10px", color: "rgba(255,255,255,0.2)", margin: 0, lineHeight: 1.5 }}>
                  The deployment name within your Azure resource. Combined with the global base URL above.
                </p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Compatible endpoints (openai-compat family) ─────────────────────────── */

/**
 * The compat family's endpoints (compat-plan §d): base URL + key + a PARAM
 * PRESET per backend. The preset picker is view-only (a dropdown listing the
 * stored preset ids + a JSON preview) — the presets themselves are code-seeded
 * rows, editing them is a later task.
 *
 * `baseUrlPinned` marks a backend whose base URL is fixed by its built-in
 * binding (OpenRouter): the field stays editable for reference, but the
 * binding's URL wins at request time.
 */
const COMPAT_ENDPOINTS: {
  id: string;
  label: string;
  hint: string;
  baseUrlPinned: boolean;
}[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    hint: "OpenAI-compatible image backend (OpenRouter dialect).",
    baseUrlPinned: true,
  },
  {
    id: "pollinations",
    label: "Pollinations",
    hint: "OpenAI-compatible image backend (Pollinations sync leg).",
    baseUrlPinned: true,
  },
  {
    id: "openai-compat",
    label: "Custom OpenAI-Compatible",
    hint: "Any OpenAI-speaking endpoint (LiteLLM, new-api, your own gateway).",
    baseUrlPinned: false,
  },
];

function CompatEndpointCard({
  id,
  label,
  hint,
  baseUrlPinned,
}: {
  id: string;
  label: string;
  hint: string;
  baseUrlPinned: boolean;
}) {
  const status = useWorkflowStore((s) => s.providerStatus[id]);
  const presets = useWorkflowStore((s) => s.presets);
  const [keyInput, setKeyInput]       = useState("");
  const [savingKey, setSavingKey]     = useState(false);
  const [error, setError]             = useState<string | null>(null);
  // Drafts: `null` ⇒ the server value shows through (the DB is the source of
  // truth). A draft is set while the user edits and dropped once the write
  // landed (or failed) — no mirroring effect needed.
  const [baseUrlDraft, setBaseUrlDraft] = useState<string | null>(null);
  const [presetDraft, setPresetDraft]   = useState<string | null>(null);
  const [presetBusy, setPresetBusy]     = useState(false);

  const baseUrl = baseUrlDraft ?? status?.baseUrl ?? "";
  const presetId = presetDraft ?? status?.presetId ?? "";

  const put = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/settings/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: id, ...body }),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(d.error ?? "Failed to save");
    }
    await refreshProviderBootstrap();
  };

  const handleSaveKey = async () => {
    const key = keyInput.trim();
    if (!key) return;
    setSavingKey(true);
    setError(null);
    try {
      await put({ apiKey: key });
      setKeyInput("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingKey(false);
    }
  };

  const handleRemoveKey = async () => {
    setError(null);
    try {
      const res = await fetch(
        `/api/settings/providers?providerId=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("Failed to remove the key");
      await refreshProviderBootstrap();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to remove the key");
    }
  };

  const handleSaveBaseUrl = async () => {
    const url = baseUrl.trim();
    if (!url || url === (status?.baseUrl ?? "")) {
      setBaseUrlDraft(null);
      return;
    }
    setError(null);
    try {
      await put({ baseUrl: url });
      setBaseUrlDraft(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save");
    }
  };

  const handlePresetChange = async (value: string) => {
    setPresetDraft(value);
    setPresetBusy(true);
    setError(null);
    try {
      await put({ presetId: value });
    } catch (e: unknown) {
      // Revert to the stored value — the write did not land.
      setPresetDraft(null);
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setPresetBusy(false);
    }
  };

  const selected = presets.find((p) => p.id === presetId);
  const hasKey = !!status?.hasKey;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        padding: "16px",
        background: "rgba(255,255,255,0.02)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: "12px",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <span
          style={{
            width: "28px", height: "28px", borderRadius: "7px",
            background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <ProviderBrandIcon id={id} size={16} />
          {/* Backends with their own brand mark (OpenRouter "OR", Pollinations
              "POL") don't need the generic "OC" fallback beside it. */}
          {id === "openrouter" || id === "pollinations" ? null : (
            <span
              style={{
                fontSize: "10px", fontWeight: 700, letterSpacing: "-0.02em",
                color: "rgba(255,255,255,0.5)",
              }}
            >
              OC
            </span>
          )}
        </span>
        <div>
          <div style={{ fontSize: "13px", fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>{label}</div>
          <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.28)", marginTop: "1px" }}>
            {hint}
          </div>
        </div>
        {hasKey && (
          <span
            style={{
              marginLeft: "auto", fontSize: "10px", fontWeight: 600,
              color: "rgba(74,222,128,0.8)", background: "rgba(74,222,128,0.08)",
              border: "1px solid rgba(74,222,128,0.2)", borderRadius: "5px",
              padding: "2px 7px", letterSpacing: "0.04em",
            }}
          >
            SAVED
          </span>
        )}
      </div>

      {/* API key */}
      <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
        <label
          htmlFor={`compat-key-${id}`}
          style={{ fontSize: "11px", fontWeight: 600, color: "rgba(255,255,255,0.4)", letterSpacing: "0.05em", textTransform: "uppercase" }}
        >
          API Key
        </label>
        {hasKey ? (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <input
              id={`compat-key-${id}`}
              type="password"
              value="placeholdertoken"
              readOnly
              style={{ ...INPUT_STYLE, flex: 1, cursor: "default", color: "rgba(255,255,255,0.3)" }}
            />
            <button
              onClick={handleRemoveKey}
              style={{
                padding: "7px 12px", borderRadius: "7px", border: "1px solid rgba(239,68,68,0.3)",
                background: "rgba(239,68,68,0.06)", color: "rgba(239,68,68,0.7)",
                cursor: "pointer", fontSize: "12px", fontWeight: 500, whiteSpace: "nowrap",
              }}
            >
              Remove
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                id={`compat-key-${id}`}
                type="password"
                placeholder="Paste your API key"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void handleSaveKey(); }}
                style={{ ...INPUT_STYLE, flex: 1 }}
                onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.2)"; }}
                onBlur={(e)  => { (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.08)"; }}
              />
              <button
                onClick={handleSaveKey}
                disabled={!keyInput.trim() || savingKey}
                style={{
                  padding: "7px 14px", borderRadius: "7px", border: "none",
                  background: keyInput.trim() ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)",
                  color: keyInput.trim() ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.25)",
                  cursor: keyInput.trim() ? "pointer" : "default",
                  fontSize: "12px", fontWeight: 500, whiteSpace: "nowrap",
                }}
              >
                {savingKey ? "Saving…" : "Save"}
              </button>
            </div>
            <p style={{ fontSize: "10px", color: "rgba(255,255,255,0.2)", margin: 0, lineHeight: 1.5 }}>
              Stored on the server — it is never exposed to the browser.
            </p>
          </div>
        )}
      </div>

      {/* Base URL */}
      <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
        <label
          htmlFor={`compat-base-url-${id}`}
          style={{ fontSize: "11px", fontWeight: 600, color: "rgba(255,255,255,0.4)", letterSpacing: "0.05em", textTransform: "uppercase" }}
        >
          Base URL
        </label>
        <input
          id={`compat-base-url-${id}`}
          type="url"
          placeholder="https://your-gateway.example.com/v1"
          value={baseUrl}
          readOnly={baseUrlPinned}
          onChange={(e) => setBaseUrlDraft(e.target.value)}
          onBlur={(e) => {
            (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.08)";
            void handleSaveBaseUrl();
          }}
          onKeyDown={(e) => { if (e.key === "Enter") void handleSaveBaseUrl(); }}
          style={{ ...INPUT_STYLE, ...(baseUrlPinned ? { color: "rgba(255,255,255,0.4)" } : {}) }}
          onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.2)"; }}
        />
        <p style={{ fontSize: "10px", color: "rgba(255,255,255,0.2)", margin: 0, lineHeight: 1.5 }}>
          {baseUrlPinned
            ? "Pinned by this backend's built-in binding — the endpoint path is appended to it."
            : "The endpoint path (/v1/images/generations) is appended to this base."}
        </p>
      </div>

      {/* Param preset */}
      <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
        <label
          htmlFor={`compat-preset-${id}`}
          style={{ fontSize: "11px", fontWeight: 600, color: "rgba(255,255,255,0.4)", letterSpacing: "0.05em", textTransform: "uppercase" }}
        >
          Param Preset
        </label>
        <select
          id={`compat-preset-${id}`}
          value={presetId}
          disabled={presetBusy}
          onChange={(e) => { void handlePresetChange(e.target.value); }}
          style={INPUT_STYLE}
        >
          <option value="">No preset (binding params only)</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id} — {p.family}
            </option>
          ))}
        </select>
        <pre
          style={{
            margin: 0,
            padding: "9px 11px",
            background: "rgba(0,0,0,0.25)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: "7px",
            fontSize: "10px",
            lineHeight: 1.5,
            color: "rgba(255,255,255,0.45)",
            fontFamily: "monospace",
            maxHeight: "180px",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {selected
            ? JSON.stringify(selected.params, null, 2)
            : "No preset selected — the binding's own params are used."}
        </pre>
        <p style={{ fontSize: "10px", color: "rgba(255,255,255,0.2)", margin: 0, lineHeight: 1.5 }}>
          The preset supplies the base request params; the binding&apos;s own params and any custom
          overrides still win.
        </p>
      </div>

      {error && (
        <p style={{ fontSize: "11px", color: "rgba(239,68,68,0.7)", margin: 0 }}>{error}</p>
      )}
    </div>
  );
}

/* ─── API Keys panel ─────────────────────────────────────────────────────────── */

const INPUT_STYLE: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: "7px",
  padding: "7px 11px",
  fontSize: "12px",
  color: "rgba(255,255,255,0.8)",
  outline: "none",
  fontFamily: "inherit",
  width: "100%",
};

function ApiKeysPanel({
  azureBaseUrl,
  onBaseUrlChange,
  kieKeyStatus,
  onKieKeySave,
  onKieKeyDelete,
  azureKeyStatus,
  onAzureKeySave,
  onAzureKeyDelete,
  codexStatus,
  onCodexLoginSuccess,
}: {
  azureBaseUrl: string;
  onBaseUrlChange: (v: string) => void;
  kieKeyStatus: "unknown" | "set" | "unset";
  onKieKeySave: (token: string) => Promise<void>;
  onKieKeyDelete: () => Promise<void>;
  azureKeyStatus: "unknown" | "set" | "unset";
  onAzureKeySave: (key: string) => Promise<void>;
  onAzureKeyDelete: () => Promise<void>;
  codexStatus: CodexStatus;
  onCodexLoginSuccess: () => void;
}) {
  const [kieInput, setKieInput]       = useState("");
  const [kieSaving, setKieSaving]     = useState(false);
  const [kieError, setKieError]       = useState<string | null>(null);
  const [azureInput, setAzureInput]   = useState("");
  const [azureSaving, setAzureSaving] = useState(false);
  const [azureError, setAzureError]   = useState<string | null>(null);

  type CodexLoginFlow =
    | { status: "idle" }
    | { status: "starting" }
    | { status: "pending"; url: string; code: string }
    | { status: "error"; error: string };
  const [loginFlow, setLoginFlow] = useState<CodexLoginFlow>({ status: "idle" });
  const [codeCopied, setCodeCopied] = useState(false);

  const handleConnectCodex = async () => {
    setLoginFlow({ status: "starting" });
    try {
      const res = await fetch("/api/settings/codex-login", { method: "POST" });
      const d = await res.json();
      if (d.status === "pending") setLoginFlow({ status: "pending", url: d.url, code: d.code });
      else setLoginFlow({ status: "error", error: d.error ?? "Failed to start login" });
    } catch (e: unknown) {
      setLoginFlow({ status: "error", error: e instanceof Error ? e.message : "Failed to start login" });
    }
  };

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code).then(() => {
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1500);
    }).catch(() => {});
  };

  /* Poll while a device-code login is pending, until it resolves */
  useEffect(() => {
    if (loginFlow.status !== "pending") return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/settings/codex-login");
        const d = await res.json();
        if (d.status === "success") {
          setLoginFlow({ status: "idle" });
          onCodexLoginSuccess();
        } else if (d.status === "error") {
          // Safety net: the login-store verdict can race the credential write.
          // Before showing a red error, confirm against codex-status (which
          // just checks auth.json on disk) — if the login actually landed,
          // treat it as success instead of latching an error.
          let recovered = false;
          try {
            const s = await fetch("/api/settings/codex-status").then((r) => r.json());
            if (s.ready || s.authFound) recovered = true;
          } catch { /* fall through to error */ }
          if (recovered) {
            setLoginFlow({ status: "idle" });
            onCodexLoginSuccess();
          } else {
            setLoginFlow({ status: "error", error: d.error ?? "Login failed" });
          }
        }
        // "pending" → keep polling
      } catch { /* network hiccup — keep polling */ }
    }, 2500);
    return () => clearInterval(interval);
  }, [loginFlow.status, onCodexLoginSuccess]);

  const handleKieSave = async () => {
    if (!kieInput.trim()) return;
    setKieSaving(true);
    setKieError(null);
    try {
      await onKieKeySave(kieInput.trim());
      setKieInput("");
    } catch (e: unknown) {
      setKieError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setKieSaving(false);
    }
  };

  const handleAzureSave = async () => {
    if (!azureInput.trim()) return;
    setAzureSaving(true);
    setAzureError(null);
    try {
      await onAzureKeySave(azureInput.trim());
      setAzureInput("");
    } catch (e: unknown) {
      setAzureError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setAzureSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
      {/* Header */}
      <div>
        <h2 style={{ fontSize: "17px", fontWeight: 600, color: "rgba(255,255,255,0.9)", margin: 0, lineHeight: 1.2 }}>
          API Keys
        </h2>
        <p style={{ fontSize: "12px", color: "rgba(255,255,255,0.28)", marginTop: "6px", lineHeight: 1.5 }}>
          Your Kie.ai key is stored securely on the server — it is never exposed to the browser.
        </p>
      </div>

      {/* ──── Kie.ai API key ──────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          padding: "16px",
          background: "rgba(255,255,255,0.02)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span
            style={{
              width: "28px", height: "28px", borderRadius: "7px",
              background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <ProviderBrandIcon id="kie" size={16} />
          </span>
          <div>
            <div style={{ fontSize: "13px", fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>Kie.ai</div>
            <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.28)", marginTop: "1px" }}>
              Used for all image &amp; video generation
            </div>
          </div>
          {kieKeyStatus === "set" && (
            <span
              style={{
                marginLeft: "auto", fontSize: "10px", fontWeight: 600,
                color: "rgba(74,222,128,0.8)", background: "rgba(74,222,128,0.08)",
                border: "1px solid rgba(74,222,128,0.2)", borderRadius: "5px",
                padding: "2px 7px", letterSpacing: "0.04em",
              }}
            >
              SAVED
            </span>
          )}
        </div>

        {kieKeyStatus === "unknown" ? (
          <div style={{ display: "flex", gap: "8px" }}>
            <div style={{
              flex: 1, height: "31px", borderRadius: "7px",
              background: "rgba(255,255,255,0.05)",
              animation: "skeleton-pulse 1.4s ease-in-out infinite",
            }} />
            <div style={{
              width: "72px", height: "31px", borderRadius: "7px",
              background: "rgba(255,255,255,0.05)",
              animation: "skeleton-pulse 1.4s ease-in-out infinite 0.2s",
            }} />
          </div>
        ) : kieKeyStatus === "set" ? (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <input
              type="password"
              value="placeholdertoken"
              readOnly
              style={{ ...INPUT_STYLE, flex: 1, cursor: "default", color: "rgba(255,255,255,0.3)" }}
            />
            <button
              onClick={onKieKeyDelete}
              style={{
                padding: "7px 12px", borderRadius: "7px", border: "1px solid rgba(239,68,68,0.3)",
                background: "rgba(239,68,68,0.06)", color: "rgba(239,68,68,0.7)",
                cursor: "pointer", fontSize: "12px", fontWeight: 500, whiteSpace: "nowrap",
              }}
            >
              Remove
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                type="password"
                placeholder="Paste your Kie.ai API token"
                value={kieInput}
                onChange={(e) => setKieInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleKieSave(); }}
                style={{ ...INPUT_STYLE, flex: 1 }}
                onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.2)"; }}
                onBlur={(e)  => { (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.08)"; }}
              />
              <button
                onClick={handleKieSave}
                disabled={!kieInput.trim() || kieSaving}
                style={{
                  padding: "7px 14px", borderRadius: "7px", border: "none",
                  background: kieInput.trim() ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)",
                  color: kieInput.trim() ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.25)",
                  cursor: kieInput.trim() ? "pointer" : "default",
                  fontSize: "12px", fontWeight: 500, whiteSpace: "nowrap",
                  transition: "background 140ms ease, color 140ms ease",
                }}
              >
                {kieSaving ? "Saving…" : "Save"}
              </button>
            </div>
            {kieError && (
              <p style={{ fontSize: "11px", color: "rgba(239,68,68,0.7)", margin: 0 }}>{kieError}</p>
            )}
            <p style={{ fontSize: "10px", color: "rgba(255,255,255,0.2)", margin: 0, lineHeight: 1.5 }}>
              Get your token at{" "}
              <a href="https://kie.ai/api-key" target="_blank" rel="noreferrer" style={{ color: "rgba(255,255,255,0.4)" }}>
                kie.ai/api-key
              </a>
            </p>
          </div>
        )}
      </div>

      {/* ──── Azure Foundry API key + endpoint ────────────────────────── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          padding: "16px",
          background: "rgba(96,165,250,0.04)",
          border: "1px solid rgba(96,165,250,0.14)",
          borderRadius: "12px",
        }}
      >
        {/* Azure logo/title row */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span
            style={{
              width: "28px", height: "28px", borderRadius: "7px",
              background: "rgba(96,165,250,0.1)", border: "1px solid rgba(96,165,250,0.2)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <ProviderBrandIcon id="azure" size={16} />
          </span>
          <div>
            <div style={{ fontSize: "13px", fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>Azure Foundry</div>
            <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.28)", marginTop: "1px" }}>
              API key &amp; base URL — used by all Azure-routed models
            </div>
          </div>
          {azureKeyStatus === "set" && (
            <span
              style={{
                marginLeft: "auto", fontSize: "10px", fontWeight: 600,
                color: "rgba(74,222,128,0.8)", background: "rgba(74,222,128,0.08)",
                border: "1px solid rgba(74,222,128,0.2)", borderRadius: "5px",
                padding: "2px 7px", letterSpacing: "0.04em",
              }}
            >
              SAVED
            </span>
          )}
        </div>

        {/* API Key */}
        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <label
            htmlFor="azure-api-key"
            style={{ fontSize: "11px", fontWeight: 600, color: "rgba(96,165,250,0.7)", letterSpacing: "0.05em", textTransform: "uppercase" }}
          >
            API Key
          </label>
          {azureKeyStatus === "unknown" ? (
            <div style={{
              height: "31px", borderRadius: "7px",
              background: "rgba(255,255,255,0.05)",
              animation: "skeleton-pulse 1.4s ease-in-out infinite",
            }} />
          ) : azureKeyStatus === "set" ? (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <input
                type="password"
                value="placeholdertoken"
                readOnly
                style={{ ...INPUT_STYLE, flex: 1, cursor: "default", color: "rgba(255,255,255,0.3)" }}
              />
              <button
                onClick={onAzureKeyDelete}
                style={{
                  padding: "7px 12px", borderRadius: "7px", border: "1px solid rgba(239,68,68,0.3)",
                  background: "rgba(239,68,68,0.06)", color: "rgba(239,68,68,0.7)",
                  cursor: "pointer", fontSize: "12px", fontWeight: 500, whiteSpace: "nowrap",
                }}
              >
                Remove
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  id="azure-api-key"
                  type="password"
                  placeholder="Paste your Azure Foundry API key"
                  value={azureInput}
                  onChange={(e) => setAzureInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleAzureSave(); }}
                  style={{ ...INPUT_STYLE, flex: 1 }}
                  onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = "rgba(96,165,250,0.4)"; }}
                  onBlur={(e)  => { (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.08)"; }}
                />
                <button
                  onClick={handleAzureSave}
                  disabled={!azureInput.trim() || azureSaving}
                  style={{
                    padding: "7px 14px", borderRadius: "7px", border: "none",
                    background: azureInput.trim() ? "rgba(96,165,250,0.15)" : "rgba(255,255,255,0.04)",
                    color: azureInput.trim() ? "rgba(96,165,250,0.9)" : "rgba(255,255,255,0.25)",
                    cursor: azureInput.trim() ? "pointer" : "default",
                    fontSize: "12px", fontWeight: 500, whiteSpace: "nowrap",
                    transition: "background 140ms ease, color 140ms ease",
                  }}
                >
                  {azureSaving ? "Saving…" : "Save"}
                </button>
              </div>
              {azureError && (
                <p style={{ fontSize: "11px", color: "rgba(239,68,68,0.7)", margin: 0 }}>{azureError}</p>
              )}
            </div>
          )}
        </div>

        {/* Base URL */}
        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <label
            htmlFor="azure-global-base-url"
            style={{ fontSize: "11px", fontWeight: 600, color: "rgba(96,165,250,0.7)", letterSpacing: "0.05em", textTransform: "uppercase" }}
          >
            Base URL
          </label>
          <input
            id="azure-global-base-url"
            type="url"
            placeholder="https://<resource>.cognitiveservices.azure.com"
            value={azureBaseUrl}
            onChange={(e) => onBaseUrlChange(e.target.value)}
            style={INPUT_STYLE}
            onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = "rgba(96,165,250,0.4)"; }}
            onBlur={(e)  => { (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.08)"; }}
          />
          <p style={{ fontSize: "10px", color: "rgba(255,255,255,0.2)", margin: 0, lineHeight: 1.5 }}>
            Combined with per-model deployment names below.
          </p>
        </div>
      </div>

      {/* ──── Compatible endpoints (openai-compat family) ───────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div>
          <div style={{ fontSize: "13px", fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>
            Compatible endpoints
          </div>
          <p style={{ fontSize: "11px", color: "rgba(255,255,255,0.28)", marginTop: "4px", lineHeight: 1.5 }}>
            Any OpenAI-speaking backend: point it at a base URL, give it a key and pick the param
            preset that describes its dialect. The preset supplies the base request params — the
            binding&apos;s own params and any custom overrides still win.
          </p>
        </div>
        {COMPAT_ENDPOINTS.map((ep) => (
          <CompatEndpointCard
            key={ep.id}
            id={ep.id}
            label={ep.label}
            hint={ep.hint}
            baseUrlPinned={ep.baseUrlPinned}
          />
        ))}
      </div>

      {/* ──── Codex CLI status ─────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          padding: "16px",
          background: "rgba(74,222,128,0.04)",
          border: "1px solid rgba(74,222,128,0.14)",
          borderRadius: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span
            style={{
              width: "28px", height: "28px", borderRadius: "7px",
              background: "rgba(74,222,128,0.1)", border: "1px solid rgba(74,222,128,0.2)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <ProviderBrandIcon id="codex" size={16} />
          </span>
          <div>
            <div style={{ fontSize: "13px", fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>Codex CLI</div>
            <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.28)", marginTop: "1px" }}>
              Uses the server&apos;s local <code style={{ fontFamily: "monospace" }}>codex login</code> session — no per-user key
            </div>
          </div>
          <span
            style={{
              marginLeft: "auto", fontSize: "10px", fontWeight: 600,
              color: codexStatus.kind === "ready" ? "rgba(74,222,128,0.8)" : "rgba(251,146,60,0.8)",
              background: codexStatus.kind === "ready" ? "rgba(74,222,128,0.08)" : "rgba(251,146,60,0.08)",
              border: `1px solid ${codexStatus.kind === "ready" ? "rgba(74,222,128,0.2)" : "rgba(251,146,60,0.2)"}`,
              borderRadius: "5px", padding: "2px 7px", letterSpacing: "0.04em", whiteSpace: "nowrap",
            }}
          >
            {codexStatus.kind === "unknown" ? "CHECKING…" : codexStatus.kind === "ready" ? "READY" : "NOT CONFIGURED"}
          </span>
        </div>

        {/* auth.json can exist but hold a stale/invalidated refresh token (e.g. the
            "session has ended" 401) — the status check only sees that the file is
            there, so it still reports READY. Offer a manual reauth escape hatch. */}
        {codexStatus.kind === "ready" && loginFlow.status === "idle" && (
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <p style={{ fontSize: "10px", color: "rgba(255,255,255,0.2)", margin: 0, lineHeight: 1.5, flex: 1 }}>
              Getting a &quot;session has ended&quot; or 401 error? Reauth below.
            </p>
            <button
              onClick={handleConnectCodex}
              style={{
                padding: "7px 14px", borderRadius: "7px", border: "1px solid rgba(74,222,128,0.3)",
                background: "rgba(74,222,128,0.1)", color: "rgba(74,222,128,0.9)",
                cursor: "pointer", fontSize: "12px", fontWeight: 500, whiteSpace: "nowrap",
              }}
            >
              Reauth
            </button>
          </div>
        )}

        {/* Starting a new login immediately invalidates any existing session on this
            host — the CLI clears old credentials the moment a login attempt begins,
            before the user does anything in the browser. Only offer it when auth is
            actually missing; a missing binary alone shouldn't risk a working login. */}
        {codexStatus.kind === "not_ready" && !codexStatus.authFound && loginFlow.status === "idle" && (
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <p style={{ fontSize: "10px", color: "rgba(255,255,255,0.2)", margin: 0, lineHeight: 1.5, flex: 1 }}>
              Requires <a href="https://github.com/jdmnk/codex-imagegen-cli" target="_blank" rel="noreferrer" style={{ color: "rgba(255,255,255,0.4)" }}>codex-imagegen-cli</a> installed on this server. Sign in below.
            </p>
            <button
              onClick={handleConnectCodex}
              style={{
                padding: "7px 14px", borderRadius: "7px", border: "1px solid rgba(74,222,128,0.3)",
                background: "rgba(74,222,128,0.1)", color: "rgba(74,222,128,0.9)",
                cursor: "pointer", fontSize: "12px", fontWeight: 500, whiteSpace: "nowrap",
              }}
            >
              Connect Codex
            </button>
          </div>
        )}

        {codexStatus.kind === "not_ready" && codexStatus.authFound && !codexStatus.installed && loginFlow.status === "idle" && (
          <p style={{ fontSize: "10px", color: "rgba(255,255,255,0.2)", margin: 0, lineHeight: 1.5 }}>
            Signed in, but <a href="https://github.com/jdmnk/codex-imagegen-cli" target="_blank" rel="noreferrer" style={{ color: "rgba(255,255,255,0.4)" }}>codex-imagegen-cli</a> isn&apos;t installed on this server yet — image generation will fail until it is.
          </p>
        )}

        {loginFlow.status === "starting" && (
          <p style={{ fontSize: "11px", color: "rgba(255,255,255,0.4)", margin: 0 }}>Starting login…</p>
        )}

        {loginFlow.status === "pending" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "12px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "8px" }}>
            <p style={{ fontSize: "11px", color: "rgba(255,255,255,0.55)", margin: 0, lineHeight: 1.6 }}>
              1. Open{" "}
              <a href={loginFlow.url} target="_blank" rel="noreferrer" style={{ color: "rgba(74,222,128,0.85)" }}>
                {loginFlow.url}
              </a>
              <br />
              2. Enter this one-time code:
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span
                style={{
                  fontFamily: "monospace", fontSize: "15px", fontWeight: 700, letterSpacing: "0.06em",
                  color: "rgba(74,222,128,0.9)", background: "rgba(74,222,128,0.08)",
                  border: "1px solid rgba(74,222,128,0.2)", borderRadius: "6px", padding: "6px 12px",
                }}
              >
                {loginFlow.code}
              </span>
              <button
                onClick={() => handleCopyCode(loginFlow.code)}
                style={{
                  padding: "6px 10px", borderRadius: "6px", border: "1px solid rgba(255,255,255,0.1)",
                  background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.6)",
                  cursor: "pointer", fontSize: "11px", fontWeight: 500,
                }}
              >
                {codeCopied ? "Copied" : "Copy"}
              </button>
            </div>
            <p style={{ fontSize: "10px", color: "rgba(255,255,255,0.25)", margin: 0 }}>
              Waiting for confirmation… the code expires in 15 minutes.
            </p>
          </div>
        )}

        {loginFlow.status === "error" && (
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <p style={{ fontSize: "11px", color: "rgba(239,68,68,0.7)", margin: 0, flex: 1 }}>{loginFlow.error}</p>
            <button
              onClick={handleConnectCodex}
              style={{
                padding: "6px 12px", borderRadius: "7px", border: "1px solid rgba(255,255,255,0.1)",
                background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.6)",
                cursor: "pointer", fontSize: "12px", fontWeight: 500, whiteSpace: "nowrap",
              }}
            >
              Try again
            </button>
          </div>
        )}
      </div>

    </div>
  );
}

/* ─── Provider legend (shared) ───────────────────────────────────────────────── */

function ProviderLegend() {
  // Visibility toggles (declutter) — a disabled provider is hidden from every
  // provider picker. The state is global, so both model panels agree.
  const disabledProviders = useWorkflowStore((s) => s.disabledProviders);
  const setProviderEnabled = useWorkflowStore((s) => s.setProviderEnabled);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", padding: "12px 16px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "10px" }}>
      {PROVIDERS.map((p) => {
        const hidden = disabledProviders.includes(p.id);
        return (
          <button
            key={p.id}
            id={`provider-visibility-${p.id}`}
            onClick={() => setProviderEnabled(p.id, hidden)}
            title={hidden ? `Show ${p.label} in the provider pickers` : `Hide ${p.label} from the provider pickers`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              opacity: hidden ? 0.4 : 1,
              textAlign: "left",
            }}
          >
            <span style={{ width: "24px", height: "24px", borderRadius: "6px", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "10px", fontWeight: 700, color: "rgba(255,255,255,0.55)", letterSpacing: "0.02em" }}>
              <ProviderBrandIcon id={p.id} />
            </span>
            <span style={{ fontSize: "12px", color: "rgba(255,255,255,0.55)", fontWeight: 500 }}>{p.label}</span>
            {hidden && (
              <span style={{ fontSize: "9px", fontWeight: 600, letterSpacing: "0.06em", color: "rgba(251,146,60,0.8)", background: "rgba(251,146,60,0.1)", border: "1px solid rgba(251,146,60,0.2)", borderRadius: "4px", padding: "1px 5px" }}>
                HIDDEN
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ─── Image Models panel ─────────────────────────────────────────────────────── */

function ImageModelsPanel({
  providers,
  onProviderChange,
  azureDeployments,
  onDeploymentChange,
}: {
  providers: Record<string, ProviderId>;
  onProviderChange: (modelId: string, v: ProviderId) => void;
  azureDeployments: Record<string, string>;
  onDeploymentChange: (modelId: string, v: string) => void;
}) {
  const models = IMAGE_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    category: "Image",
    hasAzureDeployment: !!m.azureSizeMap,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
      <div>
        <h2 style={{ fontSize: "17px", fontWeight: 600, color: "rgba(255,255,255,0.9)", margin: 0, lineHeight: 1.2 }}>
          Image Models
        </h2>
        <p style={{ fontSize: "12px", color: "rgba(255,255,255,0.28)", marginTop: "6px", lineHeight: 1.5 }}>
          Choose which provider serves each image model. Azure-capable models show a deployment name field when Azure is selected.
        </p>
      </div>
      <ProviderLegend />
      <ModelGroup
        title="Image Models"
        accent="#fb923c"
        models={models}
        providers={providers}
        onProviderChange={onProviderChange}
        azureDeployments={azureDeployments}
        onDeploymentChange={onDeploymentChange}
      />
    </div>
  );
}

/* ─── Video Models panel ─────────────────────────────────────────────────────── */

function VideoModelsPanel({
  providers,
  onProviderChange,
  azureDeployments,
  onDeploymentChange,
}: {
  providers: Record<string, ProviderId>;
  onProviderChange: (modelId: string, v: ProviderId) => void;
  azureDeployments: Record<string, string>;
  onDeploymentChange: (modelId: string, v: string) => void;
}) {
  const models = VIDEO_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    category: "Video",
    hasAzureDeployment: false,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
      <div>
        <h2 style={{ fontSize: "17px", fontWeight: 600, color: "rgba(255,255,255,0.9)", margin: 0, lineHeight: 1.2 }}>
          Video Models
        </h2>
        <p style={{ fontSize: "12px", color: "rgba(255,255,255,0.28)", marginTop: "6px", lineHeight: 1.5 }}>
          Choose which provider serves each video model.
        </p>
      </div>
      <ProviderLegend />
      <ModelGroup
        title="Video Models"
        accent="#5EEAD4"
        models={models}
        providers={providers}
        onProviderChange={onProviderChange}
        azureDeployments={azureDeployments}
        onDeploymentChange={onDeploymentChange}
      />
    </div>
  );
}

/* ─── Text Models panel ──────────────────────────────────────────────────────── */

function TextModelsPanel({
  azureKeyStatus,
  azureBaseUrl,
  azureTextDeployment,
  azureTextModelName,
  onDeploymentChange,
  onModelNameChange,
}: {
  azureKeyStatus: "unknown" | "set" | "unset";
  azureBaseUrl: string;
  azureTextDeployment: string;
  azureTextModelName: string;
  onDeploymentChange: (v: string) => void;
  onModelNameChange: (v: string) => void;
}) {
  const azureReady = azureKeyStatus === "set" && !!azureBaseUrl.trim();
  const kieGroups = MODEL_GROUPS.filter(g => g.label !== "Azure");
  // Visibility toggles (declutter) — hidden text models are not offered in the
  // chat / quick-assist model pickers.
  const disabledModels = useWorkflowStore((s) => s.disabledModels);
  const setModelEnabled = useWorkflowStore((s) => s.setModelEnabled);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
      {/* Header */}
      <div>
        <h2 style={{ fontSize: "17px", fontWeight: 600, color: "rgba(255,255,255,0.9)", margin: 0, lineHeight: 1.2 }}>
          Text Models
        </h2>
        <p style={{ fontSize: "12px", color: "rgba(255,255,255,0.28)", marginTop: "6px", lineHeight: 1.5 }}>
          Configure AI text models for chat. Azure Auto uses your Azure Foundry credentials from the API Keys tab.
        </p>
      </div>

      {/* Kie.ai models */}
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        {kieGroups.map((group) => (
          <div key={group.label}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
              <span style={{ display: "inline-block", width: "6px", height: "6px", borderRadius: "50%", background: "#e5e5e5", flexShrink: 0 }} />
              <span style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.08em", color: "rgba(255,255,255,0.35)", textTransform: "uppercase" }}>
                {group.label}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {group.models.map((m) => {
                const hidden = disabledModels.includes(m.id);
                return (
                <div
                  key={m.id}
                  style={{
                    display: "flex", alignItems: "center", gap: "14px",
                    padding: "11px 16px", borderRadius: "10px",
                    background: hidden ? "rgba(255,255,255,0.01)" : "rgba(255,255,255,0.02)",
                    border: `1px solid ${hidden ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.05)"}`,
                    opacity: hidden ? 0.5 : 1,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "13px", fontWeight: 500, color: "rgba(255,255,255,0.85)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.label}
                      {hidden && (
                        <span
                          style={{
                            marginLeft: "8px",
                            fontSize: "9px", fontWeight: 600, letterSpacing: "0.06em",
                            color: "rgba(251,146,60,0.8)", background: "rgba(251,146,60,0.1)",
                            border: "1px solid rgba(251,146,60,0.2)", borderRadius: "4px",
                            padding: "1px 5px", verticalAlign: "middle",
                          }}
                        >
                          HIDDEN
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: "11px", color: "rgba(255,255,255,0.28)", marginTop: "2px" }}>
                      Kie.ai · {m.desc}
                    </div>
                  </div>
                  <span style={{
                    display: "flex", alignItems: "center", gap: "5px",
                    padding: "3px 8px", borderRadius: "6px",
                    background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)",
                    fontSize: "11px", fontWeight: 500, color: "rgba(255,255,255,0.4)",
                    whiteSpace: "nowrap",
                  }}>
                    <span style={{ fontWeight: 700, color: "rgba(255,255,255,0.55)" }}>K</span>
                    Kie.ai
                  </span>
                  <button
                    id={`model-visibility-${m.id}`}
                    onClick={() => setModelEnabled(m.id, hidden)}
                    title={hidden ? "Show this model in the pickers" : "Hide this model from the pickers"}
                    style={{
                      flexShrink: 0,
                      display: "flex", alignItems: "center", gap: "5px",
                      padding: "5px 9px", borderRadius: "7px",
                      border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)",
                      color: hidden ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.6)",
                      cursor: "pointer", fontSize: "10px", fontWeight: 500,
                      letterSpacing: "0.04em", whiteSpace: "nowrap",
                    }}
                  >
                    {hidden ? "Show" : "Hide"}
                  </button>
                </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Azure Auto card */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          padding: "16px",
          background: "rgba(96,165,250,0.04)",
          border: "1px solid rgba(96,165,250,0.14)",
          borderRadius: "12px",
        }}
      >
        {/* Header row */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span
            style={{
              width: "28px", height: "28px", borderRadius: "7px",
              background: "rgba(96,165,250,0.1)", border: "1px solid rgba(96,165,250,0.2)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "11px", fontWeight: 700, color: "rgba(96,165,250,0.85)",
            }}
          >
            Az
          </span>
          <div>
            <div style={{ fontSize: "13px", fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>Azure Auto</div>
            <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.28)", marginTop: "1px" }}>
              Model-router — automatically selects the best model for each request
            </div>
          </div>
          <span
            style={{
              marginLeft: "auto", fontSize: "10px", fontWeight: 600,
              color: azureReady ? "rgba(74,222,128,0.8)" : "rgba(251,146,60,0.8)",
              background: azureReady ? "rgba(74,222,128,0.08)" : "rgba(251,146,60,0.08)",
              border: `1px solid ${azureReady ? "rgba(74,222,128,0.2)" : "rgba(251,146,60,0.2)"}`,
              borderRadius: "5px", padding: "2px 7px", letterSpacing: "0.04em", whiteSpace: "nowrap",
            }}
          >
            {azureReady ? "READY" : "NOT CONFIGURED"}
          </span>
        </div>

        {/* Status notice if not ready */}
        {!azureReady && (
          <div
            style={{
              padding: "10px 12px",
              background: "rgba(251,146,60,0.05)",
              border: "1px solid rgba(251,146,60,0.15)",
              borderRadius: "8px",
              fontSize: "11px",
              color: "rgba(251,146,60,0.7)",
              lineHeight: 1.5,
            }}
          >
            {azureKeyStatus !== "set"
              ? "Add your Azure Foundry API key in the API Keys tab to enable this model."
              : "Add your Azure Foundry Base URL in the API Keys tab to enable this model."}
          </div>
        )}

        {/* Two-column grid: Model Name + Deployment */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          {/* Model Name */}
          <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            <label
              htmlFor="azure-text-model-name"
              style={{ fontSize: "11px", fontWeight: 600, color: "rgba(96,165,250,0.7)", letterSpacing: "0.05em", textTransform: "uppercase" }}
            >
              Model Name
            </label>
            <input
              id="azure-text-model-name"
              type="text"
              placeholder="model-router"
              value={azureTextModelName}
              onChange={(e) => onModelNameChange(e.target.value)}
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: "7px",
                padding: "7px 11px",
                fontSize: "12px",
                color: "rgba(255,255,255,0.8)",
                outline: "none",
                fontFamily: "inherit",
              }}
              onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = "rgba(96,165,250,0.4)"; }}
              onBlur={(e)  => { (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.08)"; }}
            />
            <p style={{ fontSize: "10px", color: "rgba(255,255,255,0.2)", margin: 0, lineHeight: 1.5 }}>
              Passed as <code style={{ fontFamily: "monospace" }}>model</code> in the request body.
            </p>
          </div>

          {/* Deployment */}
          <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            <label
              htmlFor="azure-text-deployment"
              style={{ fontSize: "11px", fontWeight: 600, color: "rgba(96,165,250,0.7)", letterSpacing: "0.05em", textTransform: "uppercase" }}
            >
              Deployment
            </label>
            <input
              id="azure-text-deployment"
              type="text"
              placeholder="auto-model"
              value={azureTextDeployment}
              onChange={(e) => onDeploymentChange(e.target.value)}
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: "7px",
                padding: "7px 11px",
                fontSize: "12px",
                color: "rgba(255,255,255,0.8)",
                outline: "none",
                fontFamily: "inherit",
              }}
              onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = "rgba(96,165,250,0.4)"; }}
              onBlur={(e)  => { (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.08)"; }}
            />
            <p style={{ fontSize: "10px", color: "rgba(255,255,255,0.2)", margin: 0, lineHeight: 1.5 }}>
              Used in the URL path <code style={{ fontFamily: "monospace" }}>/deployments/{"{deployment}"}</code>.
            </p>
          </div>
        </div>

        {/* API version (read-only) */}
        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <span style={{ fontSize: "11px", fontWeight: 600, color: "rgba(96,165,250,0.7)", letterSpacing: "0.05em", textTransform: "uppercase" }}>
            API Version
          </span>
          <div style={{ padding: "7px 11px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "7px", fontSize: "12px", color: "rgba(255,255,255,0.4)", fontFamily: "monospace" }}>
            2024-04-01-preview
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Debug panel ───────────────────────────────────────────────────────────── */

function DebugPanel() {
  const debugMode     = useWorkflowStore((s) => s.debugMode);
  const toggleDebug   = useWorkflowStore((s) => s.toggleDebug);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div>
        <h2 style={{ fontSize: "15px", fontWeight: 600, color: "rgba(255,255,255,0.9)", margin: 0, marginBottom: "4px" }}>Debug</h2>
        <p style={{ fontSize: "12px", color: "rgba(255,255,255,0.35)", margin: 0 }}>
          Only visible when <code style={{ fontFamily: "monospace", color: "rgba(251,146,60,0.8)" }}>NEXT_PUBLIC_DEBUG=true</code>
        </p>
      </div>

      {/* Simulate generation */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", padding: "14px 16px", borderRadius: "10px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
          <span style={{ fontSize: "13px", fontWeight: 500, color: "rgba(255,255,255,0.85)" }}>Simulate generation</span>
          <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.35)", lineHeight: 1.5 }}>
            Skip the real API call — fake a 5-second generation and log the payload to the server console.
          </span>
        </div>
        <button
          onClick={toggleDebug}
          style={{
            flexShrink: 0,
            width: "40px",
            height: "22px",
            borderRadius: "11px",
            border: "none",
            cursor: "pointer",
            padding: "2px",
            background: debugMode ? "rgba(251,146,60,0.8)" : "rgba(255,255,255,0.12)",
            transition: "background 200ms",
            display: "flex",
            alignItems: "center",
          }}
        >
          <div style={{
            width: "18px",
            height: "18px",
            borderRadius: "50%",
            background: "#fff",
            transform: debugMode ? "translateX(18px)" : "translateX(0px)",
            transition: "transform 200ms cubic-bezier(0.34,1.56,0.64,1)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
          }} />
        </button>
      </div>
    </div>
  );
}

/* ─── Assistant panel ────────────────────────────────────────────────────────── */

const CHAT_PROVIDER_ID = "chat";

/**
 * The Assistant settings: the BYOK chat credential (server-side, via the
 * provider-credential store) and the custom system prompt (client-side, in
 * the persisted store).
 */
function AssistantPanel() {
  const customSystemPrompt = useWorkflowStore((s) => s.customSystemPrompt);
  const setCustomSystemPrompt = useWorkflowStore((s) => s.setCustomSystemPrompt);

  const [keyInput, setKeyInput]       = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [savingKey, setSavingKey]     = useState(false);
  const [savingUrl, setSavingUrl]     = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [keyStatus, setKeyStatus]     = useState<"unknown" | "set" | "unset">("unknown");
  const [savedBaseUrl, setSavedBaseUrl] = useState("");

  // Read the stored credential status (the provider bootstrap reports
  // hasKey/baseUrl for every credential row).
  useEffect(() => {
    let cancelled = false;
    void refreshProviderBootstrap().then(() => {
      if (cancelled) return;
      const status = useWorkflowStore.getState().providerStatus[CHAT_PROVIDER_ID];
      setKeyStatus(status?.hasKey ? "set" : "unset");
      setSavedBaseUrl(status?.baseUrl ?? "");
    });
    return () => { cancelled = true; };
  }, []);

  const put = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/settings/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: CHAT_PROVIDER_ID, ...body }),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(d.error ?? "Failed to save");
    }
    await refreshProviderBootstrap();
    const status = useWorkflowStore.getState().providerStatus[CHAT_PROVIDER_ID];
    setKeyStatus(status?.hasKey ? "set" : "unset");
    setSavedBaseUrl(status?.baseUrl ?? "");
  };

  const handleSaveKey = async () => {
    const key = keyInput.trim();
    if (!key) return;
    setSavingKey(true);
    setError(null);
    try {
      await put({ apiKey: key });
      setKeyInput("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingKey(false);
    }
  };

  const handleRemoveKey = async () => {
    setError(null);
    try {
      const res = await fetch(`/api/settings/providers?providerId=${CHAT_PROVIDER_ID}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to remove the key");
      await refreshProviderBootstrap();
      setKeyStatus("unset");
      setKeyInput("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to remove the key");
    }
  };

  const handleSaveBaseUrl = async () => {
    const url = baseUrlInput.trim();
    if (url === savedBaseUrl) return;
    setSavingUrl(true);
    setError(null);
    try {
      await put({ baseUrl: url });
      setBaseUrlInput("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingUrl(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
      <div>
        <h2 style={{ fontSize: "17px", fontWeight: 600, color: "rgba(255,255,255,0.9)", margin: 0, lineHeight: 1.2 }}>
          Assistant
        </h2>
        <p style={{ fontSize: "12px", color: "rgba(255,255,255,0.28)", marginTop: "6px", lineHeight: 1.5 }}>
          Use your own chat key for the assistant, and override the system prompt it runs with.
        </p>
      </div>

      {/* ─── BYOK chat key ─────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          padding: "16px",
          background: "rgba(255,255,255,0.02)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div>
            <div style={{ fontSize: "13px", fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>Chat API key</div>
            <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.28)", marginTop: "1px" }}>
              Your own OpenAI-compatible key for assistant requests
            </div>
          </div>
          {keyStatus === "set" && (
            <span
              style={{
                marginLeft: "auto", fontSize: "10px", fontWeight: 600,
                color: "rgba(74,222,128,0.8)", background: "rgba(74,222,128,0.08)",
                border: "1px solid rgba(74,222,128,0.2)", borderRadius: "5px",
                padding: "2px 7px", letterSpacing: "0.04em",
              }}
            >
              SAVED
            </span>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <label
            htmlFor="chat-api-key"
            style={{ fontSize: "11px", fontWeight: 600, color: "rgba(255,255,255,0.4)", letterSpacing: "0.05em", textTransform: "uppercase" }}
          >
            API Key
          </label>
          {keyStatus === "set" ? (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <input
                id="chat-api-key"
                type="password"
                value="placeholdertoken"
                readOnly
                style={{ ...INPUT_STYLE, flex: 1, cursor: "default", color: "rgba(255,255,255,0.3)" }}
              />
              <button
                onClick={handleRemoveKey}
                style={{
                  padding: "7px 12px", borderRadius: "7px", border: "1px solid rgba(239,68,68,0.3)",
                  background: "rgba(239,68,68,0.06)", color: "rgba(239,68,68,0.7)",
                  cursor: "pointer", fontSize: "12px", fontWeight: 500, whiteSpace: "nowrap",
                }}
              >
                Remove
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  id="chat-api-key"
                  type="password"
                  placeholder="Paste your chat API key"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleSaveKey(); }}
                  style={{ ...INPUT_STYLE, flex: 1 }}
                  onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.2)"; }}
                  onBlur={(e) => { (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.08)"; }}
                />
                <button
                  onClick={handleSaveKey}
                  disabled={!keyInput.trim() || savingKey}
                  style={{
                    padding: "7px 14px", borderRadius: "7px", border: "none",
                    background: keyInput.trim() ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)",
                    color: keyInput.trim() ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.25)",
                    cursor: keyInput.trim() ? "pointer" : "default",
                    fontSize: "12px", fontWeight: 500, whiteSpace: "nowrap",
                  }}
                >
                  {savingKey ? "Saving…" : "Save"}
                </button>
              </div>
              <p style={{ fontSize: "10px", color: "rgba(255,255,255,0.2)", margin: 0, lineHeight: 1.5 }}>
                Stored on the server — it is never exposed to the browser.
              </p>
            </div>
          )}
        </div>

        {/* Base URL — optional; defaults to the OpenAI-compatible endpoint */}
        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <label
            htmlFor="chat-base-url"
            style={{ fontSize: "11px", fontWeight: 600, color: "rgba(255,255,255,0.4)", letterSpacing: "0.05em", textTransform: "uppercase" }}
          >
            Base URL <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>(optional)</span>
          </label>
          <div style={{ display: "flex", gap: "8px" }}>
            <input
              id="chat-base-url"
              type="url"
              placeholder={savedBaseUrl || "https://api.openai.com/v1"}
              value={baseUrlInput}
              onChange={(e) => setBaseUrlInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleSaveBaseUrl(); }}
              style={{ ...INPUT_STYLE, flex: 1 }}
              onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.2)"; }}
              onBlur={(e) => { (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.08)"; }}
            />
            <button
              onClick={handleSaveBaseUrl}
              disabled={savingUrl || baseUrlInput.trim() === savedBaseUrl}
              style={{
                padding: "7px 14px", borderRadius: "7px", border: "none",
                background: baseUrlInput.trim() && baseUrlInput.trim() !== savedBaseUrl ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)",
                color: baseUrlInput.trim() && baseUrlInput.trim() !== savedBaseUrl ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.25)",
                cursor: baseUrlInput.trim() && baseUrlInput.trim() !== savedBaseUrl ? "pointer" : "default",
                fontSize: "12px", fontWeight: 500, whiteSpace: "nowrap",
              }}
            >
              {savingUrl ? "Saving…" : "Save"}
            </button>
          </div>
          <p style={{ fontSize: "10px", color: "rgba(255,255,255,0.2)", margin: 0, lineHeight: 1.5 }}>
            Any OpenAI-compatible endpoint. Leave empty to use the default.
          </p>
        </div>

        {error && (
          <p style={{ fontSize: "11px", color: "rgba(239,68,68,0.7)", margin: 0 }}>{error}</p>
        )}
      </div>

      {/* ─── Custom system prompt ──────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div>
            <div style={{ fontSize: "13px", fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>System prompt</div>
            <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.28)", marginTop: "1px" }}>
              Overrides the built-in prompt for chat &amp; quick assist
            </div>
          </div>
          {customSystemPrompt.trim() && (
            <button
              onClick={() => setCustomSystemPrompt("")}
              style={{
                marginLeft: "auto", padding: "5px 10px", borderRadius: "6px",
                border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.05)",
                color: "rgba(255,255,255,0.55)", cursor: "pointer",
                fontSize: "11px", fontWeight: 500, whiteSpace: "nowrap",
              }}
            >
              Reset to default
            </button>
          )}
        </div>
        <textarea
          value={customSystemPrompt}
          onChange={(e) => setCustomSystemPrompt(e.target.value)}
          placeholder="Leave empty to use the built-in prompt."
          rows={10}
          style={{
            ...INPUT_STYLE,
            height: "auto",
            minHeight: "180px",
            resize: "vertical",
            lineHeight: 1.5,
            fontFamily: "inherit",
          }}
        />
        <p style={{ fontSize: "10px", color: "rgba(255,255,255,0.2)", margin: 0, lineHeight: 1.5 }}>
          Stored in this browser only — it is sent with each chat request and never written to the server.
        </p>
      </div>
    </div>
  );
}

/* ─── Main modal ─────────────────────────────────────────────────────────────── */

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [activeNav, setActiveNav]             = useState<NavId>("api-keys");
  const [modelProviders, setModelProviders]   = useState<Record<string, ProviderId>>({});
  const [azureDeployments, setAzureDeployments] = useState<Record<string, string>>({});
  const [azureBaseUrl, setAzureBaseUrl]               = useState("");
  const [azureTextDeployment, setAzureTextDeployment] = useState("auto-model");
  const [azureTextModelName, setAzureTextModelName]   = useState("model-router");
  const [kieKeyStatus, setKieKeyStatus]               = useState<"unknown" | "set" | "unset">("unknown");
  const [azureKeyStatus, setAzureKeyStatus]   = useState<"unknown" | "set" | "unset">("unknown");
  const [codexStatus, setCodexStatus]         = useState<CodexStatus>({ kind: "unknown" });
  const setKieKeySet    = useWorkflowStore((s) => s.setKieKeySet);
  const setAzureKeySet  = useWorkflowStore((s) => s.setAzureKeySet);
  const overlayRef = useRef<HTMLDivElement>(null);

  async function authHeader(): Promise<Record<string, string>> {
    return {};
  }

  const refreshCodexStatus = useCallback(() => {
    fetch("/api/settings/codex-status")
      .then((r) => r.json())
      .then((d: { ready: boolean; installed: boolean; authFound: boolean }) =>
        setCodexStatus(d.ready ? { kind: "ready" } : { kind: "not_ready", installed: d.installed, authFound: d.authFound })
      )
      .catch(() => setCodexStatus({ kind: "not_ready", installed: false, authFound: false }));
  }, []);

  /* Load persisted data on mount */
  useEffect(() => {
    // Re-hydrate the store bootstrap first so the loaders below (and the
    // readiness gates elsewhere) see fresh server state, then mirror it into
    // the local editor copies.
    void refreshProviderBootstrap().then(() => {
      setModelProviders(loadModelProviders());
      setAzureDeployments(loadAzureEndpoints());
      setAzureBaseUrl(loadAzureBaseUrl());
    });
    setAzureTextDeployment(loadAzureTextDeployment());
    setAzureTextModelName(loadAzureTextModelName());
    // Check if Kie key is saved on the server
    authHeader().then((h) =>
      fetch("/api/settings/kie-key", { headers: h })
        .then((r) => r.json())
        .then((d) => setKieKeyStatus(d.hasToken ? "set" : "unset"))
        .catch(() => setKieKeyStatus("unset"))
    );
    // Check if Azure key is saved on the server
    authHeader().then((h) =>
      fetch("/api/settings/azure-key", { headers: h })
        .then((r) => r.json())
        .then((d) => setAzureKeyStatus(d.hasToken ? "set" : "unset"))
        .catch(() => setAzureKeyStatus("unset"))
    );
    // Check whether the server has a working codex-imagegen + codex login
    refreshCodexStatus();
  }, [refreshCodexStatus]);

  /* Close on Escape */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  /* Close on backdrop click */
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  const handleProviderChange = (modelId: string, v: ProviderId) => {
    const next = { ...modelProviders, [modelId]: v };
    saveModelProviders(next);
    setModelProviders(next);
  };

  const handleDeploymentChange = (modelId: string, v: string) => {
    setAzureDeployments((prev) => {
      const next = { ...prev, [modelId]: v };
      saveAzureEndpoints(next);
      return next;
    });
  };

  const handleBaseUrlChange = (v: string) => {
    setAzureBaseUrl(v);
    saveAzureBaseUrl(v);
  };

  const handleKieKeySave = async (token: string) => {
    const h = await authHeader();
    const res = await fetch("/api/settings/kie-key", {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ kieApiToken: token }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? "Failed to save");
    setKieKeyStatus("set");
    setKieKeySet(true);
    void refreshProviderBootstrap(); // readiness gates re-evaluate
  };

  const handleKieKeyDelete = async () => {
    const h = await authHeader();
    await fetch("/api/settings/kie-key", { method: "DELETE", headers: h });
    setKieKeyStatus("unset");
    setKieKeySet(false);
    void refreshProviderBootstrap();
  };

  const handleAzureKeySave = async (key: string) => {
    const h = await authHeader();
    const res = await fetch("/api/settings/azure-key", {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ azureApiKey: key }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? "Failed to save");
    setAzureKeyStatus("set");
    setAzureKeySet(true);
    void refreshProviderBootstrap();
  };

  const handleAzureKeyDelete = async () => {
    const h = await authHeader();
    await fetch("/api/settings/azure-key", { method: "DELETE", headers: h });
    setAzureKeyStatus("unset");
    setAzureKeySet(false);
    void refreshProviderBootstrap();
  };

  const handleAzureTextDeploymentChange = (v: string) => {
    setAzureTextDeployment(v);
    saveAzureTextDeployment(v);
  };

  const handleAzureTextModelNameChange = (v: string) => {
    setAzureTextModelName(v);
    saveAzureTextModelName(v);
  };

  return (
    <>
      {/* ── Keyframe animations ── */}
      <style>{`
        @keyframes settingsOverlayIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes settingsModalIn {
          from { opacity: 0; transform: translate(-50%, -48%) scale(0.96); }
          to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
        @keyframes skeleton-pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }
      `}</style>

      {/* ── Backdrop ── */}
      <div
        ref={overlayRef}
        onClick={handleOverlayClick}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          background: "rgba(0, 0, 0, 0.65)",
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
          animation: "settingsOverlayIn 180ms ease both",
        }}
      />

      {/* ── Modal shell ── */}
      <div
        id="settings-modal"
        style={{
          position: "fixed",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 10000,
          width: "min(75vw, 960px)",
          height: "min(75vh, 680px)",
          display: "flex",
          borderRadius: "18px",
          background: "rgba(10, 11, 14, 0.98)",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 32px 80px rgba(0,0,0,0.8), 0 4px 20px rgba(0,0,0,0.5)",
          overflow: "hidden",
          animation: "settingsModalIn 220ms cubic-bezier(0.22,1,0.36,1) both",
        }}
      >
        {/* ── Left sidebar ── */}
        <div
          style={{
            width: "200px",
            flexShrink: 0,
            borderRight: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            flexDirection: "column",
            padding: "20px 12px",
            gap: "2px",
          }}
        >
          {/* Title */}
          <div
            style={{
              fontSize: "14px",
              fontWeight: 600,
              color: "rgba(255,255,255,0.6)",
              padding: "4px 10px 14px",
              letterSpacing: "0.01em",
            }}
          >
            Settings
          </div>

          {/* Nav items */}
          {NAV.map((item) => {
            const isActive = activeNav === item.id;
            return (
              <button
                key={item.id}
                id={`settings-nav-${item.id}`}
                onClick={() => setActiveNav(item.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "9px",
                  padding: "8px 10px",
                  borderRadius: "8px",
                  border: "none",
                  cursor: "pointer",
                  background: isActive ? "rgba(255,255,255,0.07)" : "transparent",
                  color: isActive ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.4)",
                  fontSize: "13px",
                  fontWeight: isActive ? 500 : 400,
                  textAlign: "left",
                  transition: "background 130ms ease, color 130ms ease",
                  width: "100%",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.04)";
                    (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.6)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                    (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.4)";
                  }
                }}
              >
                <span style={{ opacity: isActive ? 1 : 0.6, flexShrink: 0 }}>{item.icon}</span>
                {item.label}
              </button>
            );
          })}
        </div>

        {/* ── Right content ── */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          {/* Top bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              padding: "16px 20px",
              borderBottom: "1px solid rgba(255,255,255,0.05)",
              flexShrink: 0,
            }}
          >
            <button
              id="settings-close"
              onClick={onClose}
              title="Close (Esc)"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: "28px",
                height: "28px",
                borderRadius: "7px",
                border: "none",
                cursor: "pointer",
                background: "rgba(255,255,255,0.05)",
                color: "rgba(255,255,255,0.4)",
                transition: "background 130ms ease, color 130ms ease",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.1)";
                (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.8)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.05)";
                (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.4)";
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Scrollable body */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "28px 28px 40px",
            }}
          >
            {activeNav === "api-keys" && (
              <ApiKeysPanel
                azureBaseUrl={azureBaseUrl}
                onBaseUrlChange={handleBaseUrlChange}
                kieKeyStatus={kieKeyStatus}
                onKieKeySave={handleKieKeySave}
                onKieKeyDelete={handleKieKeyDelete}
                azureKeyStatus={azureKeyStatus}
                onAzureKeySave={handleAzureKeySave}
                onAzureKeyDelete={handleAzureKeyDelete}
                codexStatus={codexStatus}
                onCodexLoginSuccess={refreshCodexStatus}
              />
            )}
            {activeNav === "image-models" && (
              <ImageModelsPanel
                providers={modelProviders}
                onProviderChange={handleProviderChange}
                azureDeployments={azureDeployments}
                onDeploymentChange={handleDeploymentChange}
              />
            )}
            {activeNav === "video-models" && (
              <VideoModelsPanel
                providers={modelProviders}
                onProviderChange={handleProviderChange}
                azureDeployments={azureDeployments}
                onDeploymentChange={handleDeploymentChange}
              />
            )}
            {activeNav === "text-models" && (
              <TextModelsPanel
                azureKeyStatus={azureKeyStatus}
                azureBaseUrl={azureBaseUrl}
                azureTextDeployment={azureTextDeployment}
                azureTextModelName={azureTextModelName}
                onDeploymentChange={handleAzureTextDeploymentChange}
                onModelNameChange={handleAzureTextModelNameChange}
              />
            )}
            {activeNav === "assistant" && <AssistantPanel />}
            {activeNav === "debug" && IS_DEBUG && <DebugPanel />}
          </div>
        </div>
      </div>
    </>
  );
}
