"use client";

import NextImage from "next/image";
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from "@/lib/workflowTemplates";

const GALLERY_CSS = `
  .wsd-tmpl-section {
    padding: 20px 32px 12px;
  }

  .wsd-tmpl-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 20px;
    flex-wrap: wrap;
    margin-bottom: 20px;
  }

  .wsd-tmpl-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-geist-mono), monospace;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(45, 212, 191, 0.9);
  }

  .wsd-tmpl-eyebrow-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: #2DD4BF;
    box-shadow: 0 0 8px rgba(45, 212, 191, 0.65);
  }

  .wsd-tmpl-heading {
    margin: 7px 0 0;
    font-size: 26px;
    font-weight: 600;
    line-height: 1.15;
    letter-spacing: -0.022em;
    color: #ffffff;
  }

  .wsd-tmpl-desc {
    margin: 6px 0 0;
    font-size: 13px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.48);
    max-width: 72ch;
  }

  .wsd-tmpl-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 18px;
  }

  @media (max-width: 1080px) {
    .wsd-tmpl-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }
  }

  @media (max-width: 640px) {
    .wsd-tmpl-section {
      padding: 16px 20px 8px;
    }
    .wsd-tmpl-grid {
      grid-template-columns: minmax(0, 1fr);
      gap: 14px;
    }
  }

  .wsd-tmpl-card {
    position: relative;
    background: #0C0F16;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 18px;
    overflow: hidden;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    text-align: left;
    outline: none;
    transition:
      transform 240ms cubic-bezier(.22, 1, .36, 1),
      box-shadow 240ms cubic-bezier(.22, 1, .36, 1),
      border-color 240ms ease,
      background 240ms ease;
  }

  .wsd-tmpl-card::before {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--tmpl-accent, #2DD4BF);
    opacity: 0.55;
    z-index: 3;
    transition: opacity 220ms ease, height 220ms ease;
  }

  .wsd-tmpl-card:hover,
  .wsd-tmpl-card:focus-visible {
    transform: translateY(-4px);
    background: #0E121B;
    border-color: var(--tmpl-accent-border, rgba(45, 212, 191, 0.35));
    box-shadow:
      0 0 0 1px var(--tmpl-accent-ring, rgba(45, 212, 191, 0.16)),
      0 18px 48px rgba(0, 0, 0, 0.72),
      0 4px 16px var(--tmpl-accent-glow, rgba(45, 212, 191, 0.08));
  }

  .wsd-tmpl-card:focus-visible {
    outline: 2px solid var(--tmpl-accent, #2DD4BF);
    outline-offset: 2px;
  }

  .wsd-tmpl-card:hover::before,
  .wsd-tmpl-card:focus-visible::before {
    opacity: 1;
  }

  .wsd-tmpl-card .wsd-thumbs {
    background: #1B212C;
  }

  .wsd-tmpl-card .wsd-thumb-cell {
    background: #0C0F16;
  }

  .wsd-tmpl-card:hover .wsd-thumb-overlay,
  .wsd-tmpl-card:focus-visible .wsd-thumb-overlay {
    opacity: 1;
  }

  .wsd-tmpl-card:hover .wsd-tmpl-cta,
  .wsd-tmpl-card:focus-visible .wsd-tmpl-cta {
    opacity: 1;
    transform: translateY(0);
  }

  .wsd-tmpl-card:hover .wsd-tmpl-arrow,
  .wsd-tmpl-card:focus-visible .wsd-tmpl-arrow {
    color: var(--tmpl-accent, #2DD4BF);
    transform: translateX(2px);
  }

  .wsd-tmpl-cta {
    position: absolute;
    right: 12px;
    bottom: 12px;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 11px;
    border-radius: 9px;
    background: rgba(11, 14, 20, 0.88);
    border: 1px solid var(--tmpl-accent-border, rgba(45, 212, 191, 0.42));
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    font-family: var(--font-geist-mono), monospace;
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #ffffff;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
    opacity: 0;
    transform: translateY(5px);
    transition:
      opacity 200ms cubic-bezier(.22, 1, .36, 1),
      transform 200ms cubic-bezier(.22, 1, .36, 1);
    pointer-events: none;
  }

  .wsd-tmpl-legacy-badge {
    position: absolute;
    top: 12px;
    left: 12px;
    z-index: 2;
    padding: 3px 7px;
    border-radius: 6px;
    background: rgba(11, 14, 20, 0.82);
    border: 1px solid rgba(255, 255, 255, 0.12);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    font-family: var(--font-geist-mono), monospace;
    font-size: 9.5px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.72);
    pointer-events: none;
  }

  .wsd-tmpl-body {
    flex: 1;
    padding: 15px 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    background: linear-gradient(180deg, rgba(12, 15, 22, 0.55) 0%, rgba(8, 10, 16, 0.92) 100%);
  }

  .wsd-tmpl-tags {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
  }

  .wsd-tmpl-tag {
    display: inline-flex;
    align-items: center;
    padding: 2.5px 7px;
    border-radius: 5px;
    font-family: var(--font-geist-mono), monospace;
    font-size: 9.5px;
    font-weight: 500;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    line-height: 1.3;
    white-space: nowrap;
  }

  .wsd-tmpl-title-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }

  .wsd-tmpl-name {
    font-size: 15px;
    font-weight: 600;
    color: #ffffff;
    letter-spacing: -0.015em;
    line-height: 1.3;
  }

  .wsd-tmpl-arrow {
    flex-shrink: 0;
    margin-top: 2px;
    color: rgba(255, 255, 255, 0.28);
    transition: color 180ms ease, transform 180ms ease;
  }

  .wsd-tmpl-tagline {
    margin-top: 4px;
    font-size: 12.5px;
    font-weight: 450;
    color: rgba(255, 255, 255, 0.54);
    line-height: 1.45;
  }

  .wsd-tmpl-models {
    margin-top: auto;
    padding-top: 10px;
    border-top: 1px solid rgba(255, 255, 255, 0.045);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
  }

  .wsd-tmpl-model-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2.5px 7px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.035);
    border: 1px solid rgba(255, 255, 255, 0.075);
    font-family: var(--font-geist-mono), monospace;
    font-size: 10px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.62);
    letter-spacing: 0.01em;
    line-height: 1.35;
    white-space: nowrap;
  }

  .wsd-tmpl-model-dot {
    width: 4px;
    height: 4px;
    border-radius: 999px;
    flex-shrink: 0;
  }

  .wsd-tmpl-model-more {
    display: inline-flex;
    align-items: center;
    padding: 2.5px 7px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.055);
    border: 1px solid rgba(255, 255, 255, 0.1);
    font-family: var(--font-geist-mono), monospace;
    font-size: 10px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.72);
    line-height: 1.35;
    white-space: nowrap;
  }
`;

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "").trim();
  if (clean.length !== 6) return `rgba(45, 212, 191, ${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return `rgba(45, 212, 191, ${alpha})`;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const MAX_VISIBLE_MODELS = 3;

function TemplateGalleryCard({
  template,
  onSelect,
}: {
  template: WorkflowTemplate;
  onSelect: (template: WorkflowTemplate) => void;
}) {
  const { name, tagline, description, tags, models, accent, preview, legacy } = template;
  const visibleModels = models.slice(0, MAX_VISIBLE_MODELS);
  const overflowCount = models.length - visibleModels.length;

  const cssVars = {
    "--tmpl-accent": accent,
    "--tmpl-accent-border": hexToRgba(accent, 0.36),
    "--tmpl-accent-ring": hexToRgba(accent, 0.16),
    "--tmpl-accent-glow": hexToRgba(accent, 0.1),
  } as React.CSSProperties;

  const handleActivate = () => {
    onSelect(template);
  };

  return (
    <div
      className="wsd-tmpl-card"
      role="button"
      tabIndex={0}
      aria-label={`Use template ${name}`}
      title={description}
      style={cssVars}
      onClick={handleActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleActivate();
        }
      }}
    >
      {/* 4-cell preview mosaic */}
      <div className="wsd-thumbs">
        {Array.from({ length: 4 }).map((_, i) => {
          const url = preview[i];
          return (
            <div key={i} className={`wsd-thumb-cell${url ? "" : " wsd-thumb-cell-empty"}`}>
              {url ? (
                <NextImage
                  src={url}
                  alt=""
                  fill
                  sizes="(max-width: 640px) 48vw, (max-width: 1080px) 24vw, 180px"
                  style={{ objectFit: "cover" }}
                />
              ) : (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ opacity: 0.12 }}
                >
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                  <path d="M3 16l5-5 4 4 3-3 6 5" />
                </svg>
              )}
            </div>
          );
        })}
        <div className="wsd-thumb-overlay" />

        {legacy && <span className="wsd-tmpl-legacy-badge">CLASSIC</span>}

        <div className="wsd-tmpl-cta" aria-hidden="true">
          <span>Use template</span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke={accent}
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12h14" />
            <path d="m12 5 7 7-7 7" />
          </svg>
        </div>
      </div>

      {/* Card footer / metadata */}
      <div className="wsd-tmpl-body">
        <div className="wsd-tmpl-tags">
          {tags.map((tag, idx) => (
            <span
              key={tag}
              className="wsd-tmpl-tag"
              style={
                idx === 0
                  ? {
                      color: accent,
                      background: hexToRgba(accent, 0.1),
                      border: `1px solid ${hexToRgba(accent, 0.26)}`,
                    }
                  : {
                      color: "rgba(255, 255, 255, 0.56)",
                      background: "rgba(255, 255, 255, 0.03)",
                      border: "1px solid rgba(255, 255, 255, 0.07)",
                    }
              }
            >
              {tag}
            </span>
          ))}
        </div>

        <div>
          <div className="wsd-tmpl-title-row">
            <div className="wsd-tmpl-name">{name}</div>
            <svg
              className="wsd-tmpl-arrow"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M7 17L17 7" />
              <path d="M7 7h10v10" />
            </svg>
          </div>
          <div className="wsd-tmpl-tagline">{tagline}</div>
        </div>

        <div className="wsd-tmpl-models">
          {visibleModels.map((modelId) => (
            <span key={modelId} className="wsd-tmpl-model-chip">
              <span
                className="wsd-tmpl-model-dot"
                style={{ background: hexToRgba(accent, 0.75) }}
              />
              {modelId}
            </span>
          ))}
          {overflowCount > 0 && (
            <span
              className="wsd-tmpl-model-more"
              title={models.slice(MAX_VISIBLE_MODELS).join(", ")}
            >
              +{overflowCount}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function TemplateGallery({
  onSelectTemplate,
}: {
  onSelectTemplate: (template: WorkflowTemplate) => void;
}) {
  return (
    <section className="wsd-tmpl-section" aria-labelledby="wsd-tmpl-heading">
      <style>{GALLERY_CSS}</style>

      <div className="wsd-tmpl-header">
        <div>
          <div className="wsd-tmpl-eyebrow">
            <span className="wsd-tmpl-eyebrow-dot" aria-hidden="true" />
            <span>Starter Pipelines</span>
            <span style={{ color: "rgba(255,255,255,0.22)" }}>/</span>
            <span style={{ color: "rgba(255,255,255,0.45)" }}>
              {WORKFLOW_TEMPLATES.length} templates
            </span>
          </div>
          <h2 id="wsd-tmpl-heading" className="wsd-tmpl-heading">
            Production Templates
          </h2>
          <p className="wsd-tmpl-desc">
            Pre-wired node pipelines for product stills, character consistency, storyboards, and video restyling — pick a starting graph to open a new workspace.
          </p>
        </div>
      </div>

      <div className="wsd-tmpl-grid">
        {WORKFLOW_TEMPLATES.map((template) => (
          <TemplateGalleryCard
            key={template.id}
            template={template}
            onSelect={onSelectTemplate}
          />
        ))}
      </div>
    </section>
  );
}
