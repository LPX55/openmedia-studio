<p align="center">
  <img
    src="https://raw.githubusercontent.com/SegFault42/HeliosGen/main/public/HG.svg"
    alt="HeliosGen"
    width="64"
  />
</p>

<p align="center">
  <strong>Build AI image & video pipelines visually.</strong><br/>
  Chain prompts, models, reference images, and automations on an infinite canvas.
</p>

---

# ▶️ Run it

HeliosGen is a local-first Next.js app — no account, no server, no cloud setup.
All you need is Node 22+ (`node:sqlite` powers the local database):

```bash
git clone https://github.com/SegFault42/HeliosGen
cd HeliosGen
npm install
npm run dev
```

Open http://localhost:3000. For a production build: `npm run build`, then
`npm start` (respects `PORT`).

---

## 🚀 First run

1. Launch HeliosGen.
2. Open **Settings → API Keys** and add a key for the provider you want to
   use — a generation backend (Kie.ai, Azure, OpenRouter, Pollinations, …)
   and, optionally, a separate chat key for the assistant.
3. For any **OpenAI-compatible endpoint** (OpenRouter, Pollinations, a
   self-hosted gateway, …), add it under **Settings → API Keys → Compatible
   endpoints** with its base URL, key, and a param preset — then bind models
   to it from the model lists.
4. Start generating.

Everything stays on your machine. Generations, uploads, folders, workflows and
settings live in a local SQLite database; media is saved to a local folder
(`data/` and `public/generated/` by default, overridable with
`HELIOS_DATA_DIR` / `HELIOS_MEDIA_DIR`).

Delete those folders to reset the app.

---

# 📸 Screenshots
## ✨ Simple Image & Video Generation

<p align="center">
  <img width="2912" height="2292" alt="Image generation example" src="https://github.com/user-attachments/assets/8263b83d-addb-4af8-99d1-d8406c52be2c" />
</p>

---

## 🔄 Workflow Generation

<p align="center">
  <img width="1459" height="1146" alt="Workflow generation example" src="https://github.com/user-attachments/assets/14619e50-9b8a-4ba0-b911-76d1ebdde8b6" />
</p>

---

## 🧠 Native JSON Prompt Preview

<p align="center">
  <img width="886" alt="JSON prompt preview" src="https://github.com/user-attachments/assets/dedbdf4f-9d52-4e29-ad6e-a2e67e341a73" />
</p>

---

## 💬 AI Prompt Improvement Assistant

<p align="center">
  <img width="872" height="502" alt="Prompt assistant interface" src="https://github.com/user-attachments/assets/17ba972c-bd8a-49a7-b367-4ef906fe3e17" />
</p>

# ✨ HeliosGen

HeliosGen is a free & open source visual AI workflow builder for image and video generation.

Build reusable AI pipelines with:
- infinite node-based workflows,
- multi-model generation,
- reference images,
- automation chains,
- all running 100% locally on your machine.

No subscriptions.  
No vendor lock-in.  
No cloud, no accounts — just a local app and your own provider keys.

---

# 🔌 Providers

HeliosGen talks to generation backends through a pluggable provider registry.
Built in: **Kie.ai**, **Azure AI Foundry**, **Codex CLI**, plus a generic
**OpenAI-compatible family** — point it at OpenRouter, Pollinations, a
self-hosted gateway, or any endpoint that speaks the OpenAI images format,
and bind catalog models to it. No vendor lock-in: backends are interchangeable
bindings, not code.

- **Bring your own keys** — per provider, stored locally (SQLite + env-var
  fallbacks), never leaving your machine except to call the provider itself.
- **Param presets** — reusable parameter sets (per family/dialect) referenced
  by bindings instead of hand-filling every model.
- **Per-model toggles** — hide providers or models you don't use; pickers,
  the canvas, and the gallery only offer what's enabled.
- See [`docs/compat-endpoints.md`](docs/compat-endpoints.md) for the
  compatibility registry (what's verified live vs. docs-only).

# 💬 Assistant

The built-in assistant (canvas QuickAssist, chat page, and generation nodes
with assistant turns) runs on the chat backend of your choice:

- Add your own chat key under **Settings → Assistant** (BYOK — used in
  preference to the built-in providers when set).
- Set a custom system prompt that ships with every assistant request.
- Model availability follows the same provider toggles as generation.

---

# 💳 Credits

Generation is billed by the provider you configure. Credits are purchased
directly on your own provider account and never expire.

That means:
- no monthly reset,
- no lost credits,
- no subscription lock-in,
- and full ownership of your usage.

You only pay your provider for what you generate.

---

# 🚀 Features

- Infinite node-based canvas
- AI image & video generation
- Drag-and-connect workflow system
- Multi-model pipelines
- Reference image support
- Parallel & sequential pipeline execution
- Real-time generation history
- Pluggable providers with per-model bindings
- Provider/model visibility toggles
- Custom assistant prompts with BYOK chat keys
- 100% local — your data never leaves your machine
- Bring your own provider keys
- Modern responsive UI

---

# ⚡ Supported Models

Availability per model depends on the providers you configure — bind models
to backends in **Settings → Image Models / Video Models**. (Motion-control
variants currently require the Kie.ai backend.)

## Images
- GPT Image 2 (OpenAI)
- Nano Banana / Nano Banana 2 / Nano Banana 2 Lite / Nano Banana Pro (Google)
- Seedream 5.0 Lite / Pro (Seedream)
- Z-Image (Z-AI)
- Grok Imagine (X)

## Videos
- Veo 3.1 Lite / Fast / Quality, Gemini Omni Video (Google)
- Kling 3.0, Kling 3.0 Turbo, Motion Control 2.6 / 3.0 (Kling)
- Seedance 2.0 / Fast / Mini (Bytedance)
- Grok Imagine, Grok Imagine 1.5 preview (X)
- HappyHorse (Alibaba)

More models are coming.

---

# 🏗️ Tech Stack

| Layer | Technology |
|---|---|
| App | Next.js + React + TypeScript (Node.js server) |
| Database | SQLite (local, via `node:sqlite`) |
| Storage | Local disk |
| AI Backend | Pluggable providers (Kie.ai, Azure AI Foundry, Codex CLI, OpenAI-compatible endpoints) |

---

# 🤖 Codex CLI (optional — alternate GPT Image 2 backend)

Instead of routing GPT Image 2 through a hosted generation provider, HeliosGen can generate through your own ChatGPT Codex subscription via [`codex-imagegen-cli`](https://github.com/jdmnk/codex-imagegen-cli). HeliosGen picks up `codex` from your `PATH` automatically; if it's missing, the feature just shows **NOT CONFIGURED** and everything else keeps working.

Requirements:
- A ChatGPT Plus/Pro/Team/Enterprise account with Codex access
- [`codex`](https://github.com/openai/codex) CLI installed on your machine
- [`uv`](https://docs.astral.sh/uv/) (Python package manager)

### 1. Install the Codex CLI

```bash
# macOS
brew install codex

# or, cross-platform
npm install -g @openai/codex
```

### 2. Install codex-imagegen-cli

```bash
git clone https://github.com/jdmnk/codex-imagegen-cli.git
cd codex-imagegen-cli
uv sync --dev
uv tool install -e .
```

This installs the `codex-imagegen` binary — make sure it's on your `PATH`.

### 3. Log in

Either:
- run `codex login` in a terminal (opens a browser to sign in), **or**
- open the app → **Settings → API Keys → Codex CLI → Connect Codex**, which walks you through a device-code login — visit the printed URL and enter the code, no terminal needed.

> ⚠️ Starting a new login (either way) immediately invalidates any existing session on that machine — the CLI clears old credentials the moment a login attempt begins, whether or not it's ever completed. Only start one when the status badge below shows **NOT CONFIGURED**.

### 4. Enable it for GPT Image 2

In **Settings → Image Models**, set GPT Image 2's provider toggle to **Codex CLI**. The status badge in **Settings → API Keys** shows **READY** once both the CLI and login are in place.

---

# 🛠️ Develop

```bash
git clone https://github.com/SegFault42/HeliosGen
cd HeliosGen
npm install
npm run dev
```

Runs the Next.js app with hot reload. `npm run build` + `npm start` (`PORT`
supported) for a production server.

---

# 🤝 Contributions

Contributions are welcome.

If you find a bug, have an idea, or want to improve HeliosGen:
- Open an issue
- Submit a pull request
- Share feedback or feature requests

All contributions are appreciated.

---

# 📄 License

MIT License

---

<p align="center">
  Built for creators building the future of AI workflows.
</p>
