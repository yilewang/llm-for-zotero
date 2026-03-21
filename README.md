# llm-for-zotero: Your Right-Hand Side AI Research Assistant

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![zotero target version](https://img.shields.io/badge/Zotero-8-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg?style=flat-square)](https://www.gnu.org/licenses/agpl-3.0)
[![Latest release](https://img.shields.io/github/v/release/yilewang/llm-for-zotero?style=flat-square)](https://github.com/yilewang/llm-for-zotero/releases)
[![GitHub Stars](https://img.shields.io/github/stars/yilewang/llm-for-zotero?style=flat-square)](https://github.com/yilewang/llm-for-zotero/stargazers)

<p align="center">
  <img src="./assets/label.png" alt="LLM for Zotero logo — a brain icon merged with the Zotero shield" width="512" />
</p>

**llm-for-zotero** is a plugin for [Zotero](https://www.zotero.org/) that integrates Large Language Models directly into the Zotero PDF reader. Unlike tools that require uploading PDFs to a web portal, this plugin lets you chat with your papers without leaving Zotero. It sits quietly in the reader sidebar — your standby research assistant, ready whenever you need it.

Documentation:

- [English](https://yilewang.github.io/llm-for-zotero)
- [Chinese](https://yilewang.github.io/llm-for-zotero/zh/)

<p align="center">
  <img src="./assets/demo.png" alt="Screenshot of the llm-for-zotero sidebar inside the Zotero PDF reader" width="1024" />
</p>

### 📢 Recent Updates

- **Agent Mode (beta)** — LLM-for-Zotero can now act as an autonomous agent inside your Zotero library. See [Agent Mode](#agent-mode-beta) for details.
- **Codex auth** — ChatGPT Plus subscribers can use their Codex quota to access Codex models (e.g. `gpt-5.4`) without an API key. See [Codex Auth Setup](#codex-auth-setup-chatgpt-plus-subscribers).
- **MinerU PDF parsing** — High-fidelity PDF extraction that preserves tables, equations, and figures. See [MinerU PDF Parsing](#mineru-pdf-parsing).
- **Renamed** — The plugin has been renamed from its earlier name to `llm-for-zotero`. See the [release notes](https://github.com/yilewang/llm-for-zotero/releases) for full history.

---

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Usage Guide](#usage-guide)
- [Features](#features)
- [Agent Mode (beta)](#agent-mode-beta)
- [Codex Auth Setup](#codex-auth-setup-chatgpt-plus-subscribers)
- [MinerU PDF Parsing](#mineru-pdf-parsing)
- [FAQ](#faq)
- [Contributing](#contributing)
- [Star History](#star-history)

---

## Installation

### Step 1 — Download the latest `.xpi` release

Download the latest `.xpi` file from the [Releases Page](https://github.com/yilewang/llm-for-zotero/releases).

### Step 2 — Install the add-on

Open Zotero → `Tools` → `Add-ons` → click the gear icon → **Install Add-on From File** → select the `.xpi` file.

### Step 3 — Restart Zotero

Restart Zotero to complete the installation. The plugin will automatically check for future updates when Zotero starts.

---

## Configuration

Open `Preferences` → navigate to the `llm-for-zotero` tab.

1. Select your **Provider** (e.g. OpenAI, Gemini, Deepseek).
2. Paste your **API Base URL**, **secret key**, and **model name**.
3. Click **Test Connection** to verify.

<p align="center">
  <img src="./assets/model_setting.gif" alt="Animation showing provider and model configuration" width="1024" />
</p>

The plugin natively supports multiple provider protocols: `responses_api`, `openai_chat_compat`, `anthropic_messages`, `gemini_native`, and more.

### Supported Models (examples)

| API URL                                     | Model                | Reasoning Levels                  | Notes                 |
| ------------------------------------------- | -------------------- | --------------------------------- | --------------------- |
| `https://api.openai.com/v1/responses`       | gpt-5.4              | default, low, medium, high, xhigh | PDF uploads supported |
| `https://api.openai.com/v1/responses`       | gpt-5.4-pro          | medium, high, xhigh               | PDF uploads supported |
| `https://api.deepseek.com/v1`               | deepseek-chat        | default                           |                       |
| `https://api.deepseek.com/v1`               | deepseek-reasoner    | default                           |                       |
| `https://generativelanguage.googleapis.com` | gemini-3-pro-preview | low, high                         |                       |
| `https://generativelanguage.googleapis.com` | gemini-2.5-flash     | medium                            |                       |
| `https://generativelanguage.googleapis.com` | gemini-2.5-pro       | default, low, high                |                       |
| `https://api.moonshot.ai/v1`                | kimi-k2.5            | default                           |                       |

You can also set up **multiple providers**, each with multiple models for different tasks (e.g. a multimodal model for figures, a text model for summaries). Cross-check answers across models for more comprehensive understanding.

### Advanced: Reasoning Levels & Hyperparameters

You can set different reasoning levels per model in the conversation panel (e.g. "default", "low", "medium", "high", "xhigh") depending on model support. Power users can also adjust hyperparameters like `temperature`, `max_tokens_output`, etc. for more creative or deterministic responses.

---

## Usage Guide

1. **Open any PDF** in the Zotero reader.
2. **Click the LLM Assistant icon** in the right-hand toolbar to open the sidebar.
3. **Type a question** such as _"What is the main conclusion of this paper?"_

On the first message, the model loads the full paper content as context. Follow-up questions use focused retrieval from the same paper, so the conversation stays fast and relevant.

---

## Features

### Grounded Answers with One-Click Source Navigation

<p align="center">
  <img src="./assets/citation_jump.gif" alt="Animation showing one-click jump from an AI citation to the paper source" width="1024" />
</p>

When you ask a question, the model generates answers grounded in the paper's content. Click any citation to jump straight to the source passage in your Zotero library.

### Paper Summarization

<p align="center">
  <img src="./assets/summarize.gif" alt="Animation showing an instant paper summary in the sidebar" width="1024" />
</p>

Get a concise summary of any paper in seconds. The summary is generated from the full text of the open PDF, and you can customize the prompt (e.g. focus on methodology, results, or implications).

### Selected Text Explanation

<p align="center">
  <img src="./assets/text.gif" alt="Animation showing selected text being explained by the model" width="1024" />
</p>

Select any complex paragraph or technical term and ask the model to explain it. You can add up to 5 pieces of context from the model's answer or the paper to refine the explanation.

An optional pop-up lets you add selected text to the chat with one click. Don't like it? Disable it in settings — your choice.

### Figure Interpretation

<p align="center">
  <img src="./assets/screenshot.gif" alt="Animation showing screenshot-based figure interpretation" width="1024" />
</p>

Take a screenshot of any figure and ask the model to interpret it. Supports up to 10 screenshots at a time.

### Cross-Paper Comparison

<p align="center">
  <img src="./assets/multi.gif" alt="Animation showing cross-paper comparison using the slash command" width="1024" />
</p>

Open multiple papers in different tabs and compare them side by side. Type `/` to cite another paper as additional context.

### External Document Upload

<p align="center">
  <img src="./assets/upload_files.gif" alt="Animation showing external file upload for additional context" width="1024" />
</p>

Upload documents from your local drive as additional context — supports PDF, DOCX, PPTX, TXT, and Markdown files. _(Feature by [@jianghao-zhang](https://github.com/jianghao-zhang).)_

### Save to Notes

<p align="center">
  <img src="./assets/save_notes.gif" alt="Animation showing model answers being saved to Zotero notes" width="1024" />
</p>

Save any answer or selected text to your Zotero notes with one click — seamless integration with your note-taking workflow.

### Conversation History & Export

<p align="center">
  <img src="./assets/save_chat.gif" alt="Animation showing conversation export to Zotero notes with markdown" width="1024" />
</p>

Local conversation history is automatically saved and associated with the paper you're reading. Export entire conversations to Zotero notes in Markdown format — including selected text, screenshots, and properly rendered math equations.

### Custom Quick-Action Presets

<p align="center">
  <img src="./assets/shortcuts.gif" alt="Animation showing custom quick-action preset configuration" width="1024" />
</p>

Customize quick-action presets to match your research workflow — predefined prompts available at the tap of a button.

---

## Agent Mode (beta)

> Agent Mode is disabled by default. Enable it in Preferences, then toggle `Agent (beta)` in the context bar.

When enabled, the LLM becomes an autonomous agent that can read, search, and write within your Zotero library.

### Available Tools

| Tool                       | Description                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `query_library`            | Search/list Zotero items, collections, related papers, and duplicates                      |
| `read_library`             | Read metadata, notes, annotations, attachments, and collections                            |
| `inspect_pdf`              | Read front matter, search pages, retrieve evidence, inspect the active reader view         |
| `search_literature_online` | Search live scholarly sources or fetch external metadata                                   |
| `mutate_library`           | Batch write operations — metadata edits, tagging, collection changes, note writes, imports |
| `undo_last_action`         | Revert the last approved write batch                                                       |

The design philosophy is **fewer, more general tools** rather than a long list of task-specific ones. Ask the agent what it can do — it will tell you.

### Demos

#### Multi-step workflow

<p align="center">
  <img src="./assets/agent/multi_steps.gif" alt="Animation showing multi-step agent workflow" width="512" />
</p>

#### Read a figure directly

<p align="center">
  <img src="./assets/agent/single_figure.gif" alt="Animation showing agent reading a figure from the PDF" width="1024" />
</p>

#### Read multiple pages

<p align="center">
  <img src="./assets/agent/full_docs.gif" alt="Animation showing agent reading multiple pages at once" width="1024" />
</p>

#### Find related papers

<p align="center">
  <img src="./assets/agent/related_papers.gif" alt="Animation showing agent finding related papers in the library" width="1024" />
</p>

#### Apply tags

<p align="center">
  <img src="./assets/agent/apply_tags.gif" alt="Animation showing agent applying tags to a paper" width="1024" />
</p>

#### Write a note

<p align="center">
  <img src="./assets/agent/write_note.png" alt="Animation showing agent writing a note for a paper" width="1024" />
</p>

This is the first step for Agent Mode. The goal is a versatile agent that masters all tasks in your Zotero library.

---

## Codex Auth Setup (ChatGPT Plus Subscribers)

If you have a ChatGPT Plus subscription, you can use **Codex auth** to access Codex models (e.g. `gpt-5.4`) without an API key. The plugin reuses your ChatGPT login via the Codex CLI — a great way to save on token costs.

_Special thanks to [@jianghao-zhang](https://github.com/jianghao-zhang) for contributions to this feature._

### Step-by-step setup

1. **Install the Codex CLI** (one-time):
   - **macOS:** Install [Node.js 18+](https://nodejs.org/) or `brew install node`, then:
     ```bash
     npm install -g @openai/codex
     ```
   - **macOS (Homebrew alternative):** `brew install --cask codex` (no Node.js needed).
   - **Windows/Linux:** Install [Node.js 18+](https://nodejs.org/), then `npm install -g @openai/codex`.

2. **Log in with your ChatGPT account:**

   ```bash
   codex login
   ```

   A browser window opens — sign in with your ChatGPT Plus account. Credentials are saved to `~/.codex/auth.json`.

3. **Configure the plugin** (Zotero → Preferences → llm-for-zotero):
   - **Auth Mode** → `codex auth`
   - **API URL** → `https://chatgpt.com/backend-api/codex/responses`
   - **Model** → a Codex model (e.g. `gpt-5.4`)
   - Click **Test Connection** to verify.

<p align="center">
  <img src="./assets/codex.png" alt="Screenshot showing Codex auth configuration in plugin settings" width="1024" />
</p>

### Codex Auth Technical Notes

- Reads local credentials from `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`).
- Automatically attempts token refresh on 401 responses.
- Embeddings are not supported in codex auth mode yet.
- Local PDF/reference text grounding and screenshot/image inputs are supported.
- The Responses `/files` upload + `file_id` attachment flow is not supported yet.

---

## MinerU PDF Parsing

**MinerU** is an advanced PDF parsing engine that extracts high-fidelity Markdown from PDFs — preserving tables, equations, figures, and complex layouts that standard text extraction often mangles. When enabled, the plugin sends your PDF to the MinerU API for parsing and caches the result locally. All subsequent interactions with that paper use the MinerU-parsed content, giving the LLM much richer and more accurate context.

<p align="center">
  <img src="./assets/minerU.png" alt="Screenshot showing MinerU PDF parsing results in the plugin" width="1024" />
</p>

### How to enable MinerU

1. Open Zotero → `Preferences` → `llm-for-zotero` tab.
2. Find the **MinerU** section and check **Enable MinerU**.
3. (Optional) Enter your own MinerU API key — see below.
4. Open any PDF and start chatting. The plugin will automatically parse the PDF with MinerU on first use and cache the result for future conversations.

### Using your own API key

The plugin provides a shared community proxy so MinerU works out of the box without an API key. However, the shared quota is limited. For heavier usage, you can apply for your own key:

1. Go to [mineru.net](https://mineru.net) and create an account.
2. Navigate to your account settings and generate an API key.
3. In Zotero → `Preferences` → `llm-for-zotero` → **MinerU** section, paste your API key.
4. Click **Test Connection** to verify.

When a personal API key is provided, the plugin calls the MinerU API directly (`https://mineru.net/api/v4`). Without a key, it uses the community proxy.

---

## FAQ

> **Q: Is it free to use?**
>
> Yes, absolutely free. You only pay for API calls if you choose a paid provider. With Codex auth, ChatGPT Plus subscribers can use Codex models without a separate API key. If you find this helpful, consider leaving a ⭐ on GitHub or [buying me a coffee](https://buymeacoffee.com/yat.lok).

<p align="center">
  <img src="https://github.com/user-attachments/assets/1e945e57-4b99-4d25-b8d5-fb120e100b62" width="200" alt="Alipay donation QR code">
</p>

> **Q: Does it work with local models?**
>
> Yes — as long as the local model provides an OpenAI-compatible HTTP API, you can connect it by entering the appropriate API Base URL and key in settings.

> **Q: Is my data used to train models?**
>
> No. You use your own API key, so data privacy is governed by the terms of your chosen provider (e.g. OpenAI's API terms typically exclude training on API data).

> **Q: How do I report a bug or ask a question?**
>
> Please [open an issue](https://github.com/yilewang/llm-for-zotero/issues) on GitHub. I'll do my best to help!

---

## Contributing

Contributions are welcome! Whether it's bug reports, feature requests, or pull requests — feel free to [open an issue](https://github.com/yilewang/llm-for-zotero/issues) or submit a PR.

---

## Star History

[![Star History Chart](https://api.star-history.com/image?repos=yilewang/llm-for-zotero&type=date&legend=top-left)](https://www.star-history.com/?repos=yilewang%2Fllm-for-zotero&type=date&legend=top-left)
