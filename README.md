<p align="center">
  <img src="./assets/label.png" alt="LLM for Zotero logo: a brain icon merged with the Zotero shield" width="512" />
</p>

# LLM-for-Zotero: A Research Agent System for your Zotero Library

[![Zotero support](https://img.shields.io/badge/Zotero-supported-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg?style=flat-square)](https://www.gnu.org/licenses/agpl-3.0)
[![Latest release](https://img.shields.io/github/v/release/yilewang/llm-for-zotero?style=flat-square)](https://github.com/yilewang/llm-for-zotero/releases)
[![GitHub Stars](https://img.shields.io/github/stars/yilewang/llm-for-zotero?style=flat-square)](https://github.com/yilewang/llm-for-zotero/stargazers)
[![GitHub Downloads](https://img.shields.io/github/downloads/yilewang/llm-for-zotero/total?style=flat-square)](https://github.com/yilewang/llm-for-zotero/releases)
[![buymeacoffee](https://img.shields.io/badge/Support-Buy%20Me%20A%20Coffee-FF813F?style=flat-square&logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/yat.lok)

**LLM-for-Zotero** brings Large Language Models into the Zotero reader, so
you can ask questions, summarize papers, inspect figures, compare sources,
and save notes without leaving your library. It works with standard API
providers, local OpenAI-compatible models, WebChat, Codex App-Server,
and Claude Code.

Documentation:

- [English](https://yilewang.github.io/llm-for-zotero)
- [Chinese](https://yilewang.github.io/llm-for-zotero/zh/)

<p align="center">
  <img src="./assets/demo.png" alt="Screenshot of the llm-for-zotero sidebar inside the Zotero PDF reader" width="1024" />
</p>

<img width="1863" height="1332" alt="Screenshot 2026-10-26 at 17 39 20" src="https://github.com/user-attachments/assets/8886ba6c-37a4-4da7-be1e-571d3760cf11" />

## Demo Video

How to do a library chat literature review with llm-for-zotero agent

<div align="center">
  <video
    src="https://github.com/user-attachments/assets/c3c80e9c-a8cd-487f-9b1c-49ff717f514c"
    width="1024"
    controls>
  </video>
</div>

## Table of Contents

- [At a Glance](#at-a-glance)
- [Quick Start](#quick-start)
- [What's New](#whats-new)
- [Configuration](#configuration)
- [Demos](#demos)
- [File-Based Notes](#file-based-notes)
- [Agent Mode](#agent-mode-beta)
- [Skills](#skills)
- [General Web Search](#general-web-search)
- [WebChat Setup](#webchat-setup-chatgpt-web-sync)
- [Codex Setup](#codex-setup-chatgpt-plus-subscribers)
- [Claude Code Setup](#claude-code-setup)
- [MinerU PDF Parsing](#mineru-pdf-parsing)
- [Privacy and Data Flow](#privacy-and-data-flow)
- [Roadmap](#roadmap)
- [FAQ](#faq)
- [Contributing](#contributing)

## At a Glance

- Chat with the current PDF, selected text, figures, screenshots, and uploaded
  documents directly inside Zotero.
- Get grounded answers with citations that jump back to the source passage.
- Compare multiple open papers or add external files as extra context.
- Save answers, full conversations, and research notes to Zotero notes or local
  Markdown folders such as Obsidian and Logseq.
- Enable Agent Mode for library-wide read, search, tagging, metadata, import,
  note-editing, and organization workflows.
- Search the current public web and read relevant pages with Tavily, with source links attached to the answer.
- Use your preferred backend: API keys, local models, ChatGPT WebChat, Codex App
  Server, or Claude Code.

<a id="installation"></a>
<a id="usage-guide"></a>

## What's New

- **Codex App Server** is the recommended Codex path for ChatGPT Plus users.
  It runs through the local `codex app-server` runtime and is configured from
  the **Agent** tab.
- **Claude Code Mode** runs Claude Code as a separate conversation system inside
  Zotero, using your own Claude Code login. The plugin starts and stops the
  small bridge it needs for you. It can use the plugin's Zotero tools to read
  your library and, with your approval, edit notes, tags, metadata, and imports.
- **One history** lists Agent, Codex and Claude chats together. Click the
  runtime badge in the message box to switch runtimes, and attach an earlier
  conversation from the slash menu or by asking for it in plain words.
- **Side panel** in the standalone window opens read-only past chats or a
  temporary side chat next to the main chat.

<details>
<summary>Earlier updates</summary>

- **Skills** let you customize how Agent Mode handles research workflows. The
  plugin ships with 8 built-in skills and a portal for creating your own.
- **General Web Search** lets the in-plugin Agent search the current public web with Tavily, read relevant pages, and attach source links to its answers.
- **Standalone Window Mode** opens the assistant in a dedicated window with
  paper chat, library chat, and conversation history.
- **File-Based Notes** save Markdown notes to local folders, including Obsidian,
  Logseq, or any plain Markdown directory.
- **Cache-aware Agent Mode** preserves stable paper context, prior read
  evidence, and coverage state across longer research turns, then compacts old
  transcript history automatically when the context window gets crowded.
- **Citation navigation** now keeps citation labels conservative until page
  locations are verified, while quote-based citations can jump back to the
  matching Zotero passage.
- **MinerU PDF parsing** provides higher-fidelity extraction for tables,
  equations, figures, and local `mineru-api` servers, with a richer file
  manager for bulk parsing, cache repair, sync packages, tags, and parsing
  filters.

</details>

Thanks to [@jianghao-zhang](https://github.com/jianghao-zhang) and
[@boltma](https://github.com/boltma) for major contributions to the Codex App
Server, Claude Code, and file upload workflows.

## Quick Start

1. Download the latest `.xpi` file from the
   [Releases page](https://github.com/yilewang/llm-for-zotero/releases).
2. In Zotero, open `Tools` -> `Add-ons` -> gear icon ->
   **Install Add-on From File**, then select the `.xpi`.
3. Restart Zotero.
4. Open `Preferences` -> `llm-for-zotero`, choose a provider, enter the base
   URL, key, and model, then click **Test Connection**.
5. Open a PDF in Zotero and click the LLM Assistant icon in the right-hand
   toolbar.

If you do not want to use a provider API key, start with
[WebChat](#webchat-setup-chatgpt-web-sync) or
[Codex App Server](#codex-setup-chatgpt-plus-subscribers).

## Configuration

Open `Preferences` -> `llm-for-zotero`.

1. Select your **Provider**.
2. Paste your **API Base URL**, **secret key**, and **model name**.
3. Click **Test Connection**.

<details>
<summary>Setup animation, protocols, and multiple models</summary>

<p align="center">
  <img src="./assets/model_setting.gif" alt="Animation showing provider and model configuration" width="1024" />
</p>

The plugin supports multiple provider protocols, including `responses_api`,
`openai_chat_compat`, `anthropic_messages`, and `gemini_native`.

You can configure multiple providers and models for different tasks, such as a
multimodal model for figures and a text model for summaries. The conversation
panel also supports model-specific reasoning levels and hyperparameters such as
`temperature` and `max_tokens_output`.

</details>

<a id="features"></a>

## Demos

### Grounded Paper Chat

On the first message, the model loads the current paper as context. Follow-up
questions use focused retrieval from the same paper, keeping conversations fast
and grounded.
Click any generated citation to jump straight to the source passage in Zotero.

<details>
<summary>Show demo</summary>

<p align="center">
  <img src="./assets/citation_jump.gif" alt="Animation showing one-click jump from an AI citation to the paper source" width="1024" />
</p>

</details>

### Summaries and Selected Text

Summarize a full paper, focus on methodology or results, or select any paragraph
and ask the model to explain it.
The selected-text pop-up can add highlighted text to chat with one click. It can
also be disabled in settings.

<details>
<summary>Show demos</summary>

<p align="center">
  <img src="./assets/summarize.gif" alt="Animation showing an instant paper summary in the sidebar" width="1024" />
</p>

<p align="center">
  <img src="./assets/text.gif" alt="Animation showing selected text being explained by the model" width="1024" />
</p>

</details>

### Figures and External Files

Take screenshots of figures, attach up to 10 screenshots, or upload local files
as additional context. Supported uploads include PDF, DOCX, PPTX, TXT, and Markdown.

<details>
<summary>Show demos</summary>

<p align="center">
  <img src="./assets/screenshot.gif" alt="Animation showing screenshot-based figure interpretation" width="1024" />
</p>

<p align="center">
  <img src="./assets/upload_files.gif" alt="Animation showing external file upload for additional context" width="1024" />
</p>

</details>

### Multi-Paper Comparison

Open multiple papers in Zotero tabs and type `/` to cite another paper as
additional context.

<details>
<summary>Show demo</summary>

<p align="center">
  <img src="./assets/multi.gif" alt="Animation showing cross-paper comparison using the slash command" width="1024" />
</p>

</details>

### Notes, History, and Presets

Save answers or selected text to Zotero notes, export full conversations in
Markdown, and customize quick-action presets for repeated research tasks.

<details>
<summary>Show demos</summary>

<p align="center">
  <img src="./assets/save_notes.gif" alt="Animation showing model answers being saved to Zotero notes" width="1024" />
</p>

<p align="center">
  <img src="./assets/save_chat.gif" alt="Animation showing conversation export to Zotero notes with markdown" width="1024" />
</p>

<p align="center">
  <img src="./assets/shortcuts.gif" alt="Animation showing custom quick-action preset configuration" width="1024" />
</p>

</details>

## File-Based Notes

Beyond Zotero's built-in notes, the agent can save Markdown research notes to
any local directory you choose. Point it at an
[Obsidian](https://obsidian.md/) vault, a [Logseq](https://logseq.com/) graph,
or a plain folder of `.md` files.

<details>
<summary>Notes Directory settings and note examples</summary>

Open `Preferences` -> `llm-for-zotero` and scroll to the **Notes Directory**
section.

<p align="center">
  <img src="./assets/outside_notes.png" alt="Screenshot of the Notes Directory settings panel" width="512" />
</p>

| Setting                  | Description                                                          | Example              |
| ------------------------ | -------------------------------------------------------------------- | -------------------- |
| **Nickname**             | How you refer to this directory in chat                              | `Obsidian`, `Logseq` |
| **Notes Directory Path** | Absolute path to the root directory where notes are saved            | `/Users/me/MyVault`  |
| **Default Folder**       | Default subfolder for new notes                                      | `Logs`               |
| **Attachments Folder**   | Folder for copied figures and images, relative to the directory root | `Logs/imgs`          |

Ask the agent to write a note using the configured nickname, for example:
_"Summarize this paper and save it to Obsidian."_ The agent gathers paper
metadata, writes a Markdown note, adds YAML frontmatter, optionally copies
figures from MinerU-parsed PDFs, and saves the note under the configured folder.

Or if you want to keep notes inside Zotero, the agent can also write to internal item notes with the `write-note` skill. Just ask it to "save a note for this paper" without mentioning an external directory.

### Zotero Notes vs. File-Based Notes (both generated by the plugin)

<p align="center">
  <img src="./assets/note2.jpeg" alt="Zotero internal note" width="512" />
</p>

<p align="center">
  <img src="./assets/obsidian_example.png" alt="Example of a paper note rendered in Obsidian" width="512" />
</p>

Notes use [Pandoc citation syntax](https://pandoc.org/MANUAL.html#citations)
such as `[@citekey]`, which works with Obsidian Zotero Integration, Pandoc
plugins, and many Markdown readers.

> Note templates and figure-embedding rules live in the `write-note` skill.
> Open the **Standalone Window** -> **Skills** portal to edit them.

</details>

### Editing Zotero Notes With the Agent

The agent keeps citations, PDF highlights, and images intact when it edits a
Zotero note.

<details>
<summary>How note editing works</summary>

- **Citations, PDF highlights, and images stay intact.** The agent sees each
  one as a placeholder such as `{{citation:3fa9c1 ("Smith", 2020, p. 42)}}`
  and every edit puts the original item back, so a rewrite can move a
  citation but never break it. An edit that would drop one is refused unless
  you asked for it to be deleted.
- **Clickable citations.** Ask for page citations and the agent writes
  `{{cite item=123 page=42}}`, which becomes the same citation Zotero's
  **Insert Citation** makes: clicking it opens the PDF at that page.
- **Study-note blanks.** A line of underscores inside a quote (`> ___`) becomes
  a divider, and a checklist item made only of underscores (`- [ ] ____`)
  keeps its checkbox as a fill-in blank.

</details>

## Agent Mode (beta)

Agent Mode is disabled by default. Turn on **Original Agent** in `Preferences`
-> **Agent** tab. While it is on, new chats use the Agent. If you also turn on Codex or
Claude Code, click the runtime badge in the message box to switch between them.

It can read and search your library, draft notes, update metadata or tags with
confirmation, and undo recent write actions from the conversation.

When enabled, the LLM can act on your Zotero library with read tools, write
tools, confirmation cards, and undo.

The design philosophy is simple: read tools are unrestricted; write tools stay
reviewable and undoable.

<details>
<summary>Agent tools and long runs</summary>

Long agent runs are cache-aware. The plugin keeps stable Zotero context and
previously read evidence separate from the changing chat transcript, tracks which
papers and passages have already been inspected, and automatically compacts old
turns when the model context fills up. This lets follow-up questions reuse
grounded evidence when it is still relevant, while still asking the agent to read
again when the needed source or coverage layer is missing.

| Tool area                | Tools                                                                                                 | What they do                                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library and PDF reading  | `library_search`, `library_read`, `library_retrieve`, `paper_read`, `read_attachment`, `context_read` | Search items and collections, read metadata, read papers, search paper passages, render PDF pages, inspect attachments and the chat context                                       |
| Scholarly discovery      | `literature_search`, `literature_review`                                                              | Search OpenAlex, arXiv, and Europe PMC for papers, recommendations, references, and citations (metadata lookup via CrossRef and Semantic Scholar), then present ranked candidates |
| General web research     | `web_search`, `web_read`                                                                              | Search the current public web with Tavily, read relevant pages, and show source links with the answer (only when a Tavily key is set)                                             |
| Library writes           | `library_update`, `library_import`, `library_delete`, `annotate_pdf`                                  | Apply tags, update metadata, move items, manage collections and attachments, merge duplicates, trash items, import identifiers or local files, highlight PDF passages             |
| Citations and settings   | `library_cite`, `library_settings`                                                                    | Format citations and bibliographies with Zotero's citation engine, and read or change the Zotero preferences the agent may touch                                                  |
| Notes and documents      | `note_write`, `note_write_batch`, `submit_document`                                                   | Create, append to, or edit Zotero notes, write one note on each of many items, and finalize longer documents                                                                      |
| Filesystem and scripting | `file_io`, `run_command`, `zotero_script`                                                             | Read/write local files, run analysis commands, or execute Zotero JavaScript with write confirmations                                                                              |
| Skills and questions     | `load_skill`, `request_user_input`, `past_chat_attach`                                                | Load a skill's instructions when the task needs them, ask you a question when a choice is ambiguous, and add an earlier conversation to the chat                                  |
| Task tracking            | `task_update`, `workflow_script`                                                                      | Split a compound request into parts the plugin tracks, and run several tool calls in one script with loops and conditions                                                         |
| Safety                   | `undo`                                                                                                | Undo recorded write actions from the conversation's durable change history, one at a time or several newest-first                                                                 |

</details>

### Agent Mode Demos

<details>
<summary>Multi-step work, related papers, tags, and notes</summary>

#### Multi-step workflow

<p align="center">
  <img src="./assets/agent/multi_steps.gif" alt="Animation showing multi-step agent workflow" width="512" />
</p>

#### Find related papers

Use `/discover_related` while viewing a paper to run the direct OpenAlex action.
It opens Recommendations, References, and Citations tabs with up to 20 papers per mode by default.
Use `/discover_related 30` to change the initial retrieval limit, **Load more** to retrieve 20 more per mode while preserving your selections, and **Import selected** to save the papers you choose.
This shortcut does not require a model.

Ask “find relevant papers” in chat to start model-assisted discovery.
The agent assesses retrieved candidates and presents a ranked card with relevance reasons.
An explicit count, such as “find 15 relevant papers,” sets the batch size; otherwise it starts with five.
Use **Find more** to add another batch of the same size while preserving your selections, then **Import selected** to save the papers you choose.
Requests for references, citing papers, or a specific search source constrain discovery to that request.
If fewer relevant matches are available, the card explains the shortfall instead of padding the list.
A configured model is required for model-assisted discovery; literature search used to answer a question remains a separate flow that can finish with a cited answer without an import card.

<p align="center">
  <img src="./assets/agent/related_papers.gif" alt="Animation showing agent finding related papers in the library" width="1024" />
</p>

#### Apply tags

<p align="center">
  <img src="./assets/agent/apply_tags.gif" alt="Animation showing agent applying tags to a paper" width="1024" />
</p>

#### Write a note

<p align="center">
  <img src="./assets/agent/write_note.png" alt="Screenshot showing agent writing a note for a paper" width="1024" />
</p>

</details>

## Skills

Skills customize Agent Mode behavior for recurring research workflows such as
paper QA, evidence retrieval, figure analysis, paper comparison, literature
reviews, note writing, and cited-reference import.

<details>
<summary>Built-in skills and custom skill setup</summary>

<p align="center">
  <img src="./assets/skills.png" alt="Screenshot of the Skills management portal" width="512" />
</p>

Skills are customizable guidance files that shape how Agent Mode approaches different types of requests.
The agent sees only each skill's name and description at the start of a turn.
There is no automatic pre-selection step: the agent calls `load_skill` to read a skill's full instructions when it decides the task needs them.
Choosing a skill with `/` applies it directly, and an approved plan keeps the exact skill versions it was approved with.

> Skills require **Agent Mode**. They have no effect in standard chat mode.

Built-in skills:

| Skill                    | What it guides the agent to do                                    |
| ------------------------ | ----------------------------------------------------------------- |
| `evidence-based-qa`      | Retrieve missing evidence for specific paper questions            |
| `analyze-figures`        | Interpret figures and tables using MinerU-extracted images        |
| `compare-papers`         | Compare multiple papers using batched reads and focused retrieval |
| `library-analysis`       | Summarize or analyze your entire library without context overflow |
| `literature-review`      | Conduct a structured literature review                            |
| `reorganize-library`     | Sort papers into folders or tags after you review the grouping    |
| `write-note`             | Write Zotero notes or Markdown notes in configured local folders  |
| `import-cited-reference` | Import papers cited in the current PDF into Zotero                |

To create a custom skill, open the **Standalone Window**, click the **Skills**
icon, choose **"+ New skill"**, edit the skill file, and save. Skills are stored
as Markdown files in `{ZoteroDataDir}/llm-for-zotero/skills/`.

</details>

## General Web Search

Agent Mode can search the current public web with Tavily, AnySearch, or DeepSeek and read returned pages when search-result snippets are not enough.
Use it for current facts, official documentation, news, finance, product information, and other general-web evidence.
Scholarly discovery remains separate: the agent searches OpenAlex, arXiv, and Europe PMC (with CrossRef and Semantic Scholar for metadata lookup), and it can combine both kinds of search when a question needs academic and general-web sources.

<details>
<summary>Set up web search with Tavily, AnySearch, or DeepSeek</summary>

To enable general web search with Tavily:

1. Get a Tavily API key from [app.tavily.com](https://app.tavily.com/).
2. Open `Preferences` -> `llm-for-zotero` -> **Agent**.
3. In **Web search**, keep **Tavily** (the default), paste the API key and click **Test connection**.
4. Enable Agent Mode and ask it to search or verify something online.

There is no separate enable switch.
The `web_search` and `web_read` tools become available to compatible in-plugin Agent conversations when the selected provider can run: Tavily has a key, AnySearch is selected, or DeepSeek finds an official DeepSeek model profile.
Tavily is the default.
**DeepSeek** is an optional choice that uses the key of an official DeepSeek model profile, and DeepSeek bills that account.
They are not added to WebChat, Codex App Server, or Claude Code conversations, which use their own runtimes and tool sets.

With Tavily, the agent chooses basic or advanced search and page-reading depth from the request, or follows an explicit request such as _"use advanced web search."_
It can narrow searches by topic, date, or domain, and answers include clickable source indicators for the pages actually used.

Basic search costs 1 Tavily credit and advanced search costs 2.
Page extraction also consumes Tavily credits, and Tavily currently offers a free monthly allowance.
The API key stays in local Zotero preferences, but search queries and requested URLs are sent to Tavily, so do not include credentials or sensitive private text in web queries.

### AnySearch

In **Preferences → llm-for-zotero → Agent → Web search**, select
**AnySearch**. Leave **AnySearch API key (optional)** blank for anonymous
access, or enter an existing key. Saving preferences does not make a request.
The provider selection is persisted; selecting AnySearch does not reuse a
Tavily key. No environment-variable key fallback is used.
**Test search (sends a public query)** explicitly sends a fixed public query
without invoking a model and displays result count, titles, URLs and the
request ID when available. It consumes service quota; it is not an Agent
conversation or proof of the Agent tool/citation path.

AnySearch supports general search with `query` and `maxResults` (1–10),
and `web_read` with one to five URLs returned by search in the same run.
Extraction uses at most two concurrent requests and returns bounded page text,
not query-focused passages. Depth, topic, date/domain filters, chunk controls
and vertical/source selection are not supported and are rejected rather than
silently ignored. PDF, Office and media-binary extraction are not supported.
Search queries and requested URLs are sent to AnySearch; do not include
credentials or private library content.

Anonymous quotas and permissions are server-controlled. An exhausted quota
produces an error; the integration does not adopt credentials from responses,
automatically retry, switch providers, or report fictional credit usage.

### DeepSeek

DeepSeek search uses the key of your first model profile whose API address is the official `https://api.deepseek.com`; keys of relays and other hosts are never sent to DeepSeek.
It costs $0.75 per 1,000 successful searches or page fetches, billed to that DeepSeek account, and failed or empty calls are not billed.
Queries are limited to 128 characters, including the site and date filters, and search queries and requested URLs are sent to DeepSeek.

</details>

## Codex Setup (ChatGPT Plus Subscribers)

If you have a ChatGPT Plus subscription, you can use Codex models in the plugin
without a separate API key by signing in through the Codex CLI.

New users should choose **Codex App Server** from the **Agent** tab. The older
**Codex Auth (Legacy)** path remains available for existing users, but is
planned for future deprecation after app-server validation.

<details>
<summary>Codex App Server setup and legacy Codex Auth</summary>

<p align="center">
  <img src="./assets/codex_claude.png" alt="Screenshot showing recommended Codex App Server configuration in plugin settings" width="512" />
</p>

### Codex App Server setup

1. Install the Codex CLI:

   ```bash
   npm install -g @openai/codex
   ```

   On macOS, you can also use `brew install --cask codex`.
   On Windows, you can also use `winget install OpenAI.Codex`; install Codex from PowerShell or Command Prompt rather than WSL, so Zotero MCP can use the Windows-local loopback connection.

2. Log in:

   ```bash
   codex login
   ```

   Credentials are saved to `~/.codex/auth.json`.

3. In Zotero, open `Preferences` -> `llm-for-zotero` -> **Agent** tab.
4. Turn on **Enable Codex App Server integration**.
5. Choose the default model and reasoning level.
6. Click **Test connection**.
7. In the chat header, click **Codex** to switch into the Codex conversation
   system.

`Codex App Server` and `Claude Code` are mutually exclusive runtime modes in the
Agent tab. Disable one before enabling the other.

### Codex Auth (Legacy)

Existing users can keep the legacy direct backend configuration:

- Open the **AI Providers** tab.
- Choose **Auth Mode** -> `Codex Auth (Legacy)`.
- Keep API URL `https://chatgpt.com/backend-api/codex/responses`.
- Keep your Codex model name, for example `gpt-5.5`.

Legacy notes:

- Reads credentials from `~/.codex/auth.json` or `$CODEX_HOME/auth.json`.
- Automatically attempts token refresh on 401 responses.
- Embeddings are not supported in this legacy direct mode yet.
- Local PDF/reference text grounding and screenshot/image inputs are supported.
- The Responses `/files` upload plus `file_id` attachment flow is not supported
  yet.

</details>

## Claude Code Setup

Claude Code mode runs Claude Code as a separate conversation system inside
Zotero. It reuses the sidebar and standalone-window UI, but has its own scope
state, model settings, permission semantics, slash commands, and project
skills. Claude chats appear in the same history list as your other chats, with
a small **Claude** label.

_Special thanks to [@jianghao-zhang](https://github.com/jianghao-zhang), who
built the Claude Code integration and its bridge
([`cc-llm4zotero-adapter`](https://github.com/jianghao-zhang/cc-llm4zotero-adapter)).
The bridge now ships inside the plugin, with the author's permission, under
[`packages/claude-bridge`](./packages/claude-bridge)._

> Claude Code mode can use the plugin's Zotero tools.
> It searches and reads your library and papers without asking.
> Library changes, such as editing notes, tagging papers, updating metadata, or
> importing items, follow your Claude Code **Permission mode**.
> In `safe` mode, they ask for your approval first.

<details>
<summary>Claude Code setup, troubleshooting, and project assets</summary>

You need two things on your computer. The plugin takes care of the rest.

- **Node.js 18 or newer.** Download it from [nodejs.org](https://nodejs.org)
  (the LTS version is fine), or use a version manager such as NVM, Volta or
  Homebrew. Check it in a terminal with `node --version`.
- **Claude Code, installed and logged in.** Follow Anthropic's
  [installation](https://code.claude.com/docs/en/installation.md) and
  [authentication](https://code.claude.com/docs/en/authentication.md) guides.
  You can use your Claude subscription or an API key.

### 1. Install and log in to Claude Code

In a terminal, run:

```bash
claude
```

Finish the login steps it shows, then close it. You only need to do this once.

### 2. Turn on Claude Code inside Zotero

Open `Preferences` -> `llm-for-zotero` -> **Agent** tab, and switch on
**Claude Code**. Recommended settings:

| Setting               | Recommended value                  |
| --------------------- | ---------------------------------- |
| **Claude Code**       | `On`                               |
| **Config source**     | `default - user + project + local` |
| **Permission mode**   | `safe`                             |
| **Default model**     | `sonnet`                           |
| **Default reasoning** | `auto`                             |

Then click the **Claude Code** button in the chat header, or click the runtime
badge in the message box and pick **Claude**, to enter Claude Code mode.

That is all. You do **not** need to download or start a bridge yourself. While
Claude Code mode is on, Zotero starts a small helper program (the "bridge")
that connects Zotero to your Claude Code. It runs only on your computer, only
answers Zotero, and stops when you quit Zotero or turn Claude Code off. If you
never turn on Claude Code, nothing extra runs.

The **Bridge** section at the top of the Claude Code settings shows whether the
bridge is running. Use **Restart bridge** if something seems stuck, and
**Open log** to see what the bridge reported.

Keep **Config source** on `default` unless you already understand Claude
Code settings layers. In `default`, Claude Code can use your normal user
settings plus Zotero-managed project and per-conversation local settings.
The other options are:

- `user-only`: only your machine-wide Claude settings.
- `zotero-only`: only Zotero-managed project and local settings.

### 3. If it does not work

The Bridge status line says what is wrong in plain words. The usual causes:

| The status says                  | What to do                                                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node.js was not found**        | Install Node.js 18 or newer. If it is installed but Zotero cannot find it, run `which node` (macOS, Linux) or `where node` (Windows) in a terminal and paste the result into **Advanced** -> **Node.js path**. |
| **needs Node.js 18 or newer**    | Install a newer Node.js from [nodejs.org](https://nodejs.org).                                                                                                                                                 |
| **Claude Code was not found**    | Install Claude Code. If it is installed, run `which claude` (macOS, Linux) or `where claude` (Windows) and paste the result into **Advanced** -> **Claude Code path**.                                         |
| Running, but Claude replies fail | Claude Code is probably not logged in. Run `claude` in a terminal and log in, then press **Restart bridge**.                                                                                                   |
| **keeps stopping**               | Press **Open log** to see why, fix the cause, then press **Restart bridge**.                                                                                                                                   |

Zotero opened from the Dock or Start menu does not always see the same programs
as your terminal. The plugin looks in the usual places (NVM, Volta, Homebrew,
`~/.local/bin` and the Claude Code installer's folder), but the two path
settings are there if it still cannot find them.

**Advanced options**

- **Extra bridge options** passes command-line options to the bridge, for
  example `--additional-directories ~/Papers` to let Claude read another
  folder, or `--append-system-prompt-file ~/zotero-claude.md`. Press
  **Restart bridge** after changing it.
- **Use my own bridge** is for people who run the bridge themselves, for
  example inside WSL while Zotero runs on Windows, or on another computer.
  Zotero then sends Claude requests to the **Bridge URL** and does not start
  its own bridge. The bridge's code lives in
  [`packages/claude-bridge`](./packages/claude-bridge); see its README for how
  to run it by hand.

**Upgrading from the old `cc-llm4zotero-adapter`**

Earlier versions needed the separate
[`cc-llm4zotero-adapter`](https://github.com/jianghao-zhang/cc-llm4zotero-adapter)
repository and `npm run serve:bridge` or `npm run daemon:*`. That is no longer
needed. Your Claude Code conversations, skills and settings keep working,
because the new bridge uses the same `~/Zotero/agent-runtime` and
`~/Zotero/agent-state` folders.

If you installed the old macOS background service, it can stay, since it does
not get in the way, but it is no longer used. Zotero tells you once if it finds
it. To remove it, run this in your old adapter folder:

```bash
npm run daemon:uninstall
```

If you already deleted that folder, run these two commands instead:

```bash
launchctl bootout gui/$(id -u)/com.toha.ccbridge
rm ~/Library/LaunchAgents/com.toha.ccbridge.plist
```

### 4. Claude project skills and commands

Zotero creates a Claude runtime root under your home directory, usually shaped
like:

```text
~/Zotero/agent-runtime/profile-.../
```

Shared Claude project assets live in:

```text
CLAUDE.md
.claude/settings.json
.claude/skills/
.claude/commands/
```

Each Claude conversation also gets its own local `.claude` folder under the
runtime `scopes/` tree, so per-conversation overrides do not leak into other
chats.

The Zotero UI loads the model catalog advertised by the Claude Code bridge and preserves each model value exactly, including aliases, explicit model IDs, context-window variants, custom provider values, and future model families.
The chat model picker identifies the active conversation so discovery uses the same scoped `.claude/settings.local.json` stack as the turn.
The model preference remains editable when discovery is unavailable.
Claude Code is responsible for resolving or rejecting the selected value and for applying provider or proxy configuration.

</details>

## MinerU PDF Parsing

**MinerU** is an advanced PDF parsing engine that extracts high-fidelity
Markdown from PDFs, preserving tables, equations, figures, and complex layouts
that standard text extraction often mangles.

When enabled, the plugin sends newly added PDF attachments to MinerU for parsing
and caches the result locally. Later interactions with that paper use the
MinerU-parsed content.

<details>
<summary>MinerU setup, local server, and cache management</summary>

<p align="center">
  <img src="./assets/minerU.png" alt="Screenshot showing MinerU PDF parsing results in the plugin" width="512" />
</p>

### How to enable MinerU

1. Open `Preferences` -> `llm-for-zotero`.
2. Find the **MinerU** section and check **Enable MinerU**.
3. Keep cloud mode enabled, or check **Use local MinerU server** for local mode.
4. For cloud mode, optionally enter your own MinerU API key — see below.
5. For local mode, run a self-hosted `mineru-api` server and keep the default
   base URL (`http://127.0.0.1:8000`) unless your server uses a different
   address.
6. Add or import a PDF into your Zotero library. The plugin will automatically
   parse newly added PDF attachments with MinerU and cache the result for future conversations.

MinerU can start without an API key through the built-in API, but a personal key
is strongly recommended. The built-in API may no longer be supported after
June 1, 2026.

To get a free personal key:

1. Go to [mineru.net](https://mineru.net) and create an account.
2. Navigate to account settings and generate an API key.
3. In Zotero, paste the key into the **MinerU** section.
4. Click **Test Connection**.

When a personal key is provided, the plugin calls
`https://mineru.net/api/v4` directly.

### Using a local MinerU server

Local MinerU server support was contributed by
[@renyong18](https://github.com/renyong18) in
[PR #152](https://github.com/yilewang/llm-for-zotero/pull/152).

Local mode sends PDFs to a self-hosted `mineru-api` server through
`POST /file_parse` and stores the returned ZIP output in the same local cache
format as cloud parsing. The default base URL is `http://127.0.0.1:8000`.

**Prerequisites for local mode**:

1. Install MinerU and run `mineru-api` (see the
   [MinerU docs](https://github.com/opendatalab/MinerU) for installation).
2. Make sure required models are downloaded — `mineru-api` lazy-loads on first
   request, so the very first parse (or the first parse after switching backend)
   can take noticeably longer than steady state.

You can pick a `Backend` in the local section:

- `pipeline` (default) — general-purpose, multi-language, CPU-friendly.
- `vlm` — VLM-based, high accuracy on Chinese/English documents, requires GPU.
- `hybrid` — newer high-accuracy hybrid pipeline, multi-language, requires
  local compute.

The first parse after starting the local server, or after changing backend, can
be slow while MinerU loads or downloads models. `Test Connection` checks that
the server process responds at `/health`; it does not guarantee that all models
are warmed up.

With the default `127.0.0.1` address, PDFs stay on your machine. If you change
the base URL to a LAN or remote server, PDFs are sent to that server.

**Pause / cancel limitation**: `mineru-api` exposes no cancel or DELETE endpoint
(only `POST /file_parse`, `POST /tasks`, `GET /tasks/{id}`,
`GET /tasks/{id}/result`, `GET /health`). When you click Pause, the plugin stops
the queue and aborts the HTTP wait, but the parse already running on the server
keeps executing until it finishes — the GPU/CPU will not free up sooner. If you
need to abort immediately (for example to switch backend without waiting),
restart the `mineru-api` process yourself.

### Managing MinerU caches

The **MinerU** preferences tab includes a **Manage Files** panel for maintaining
parsed PDF caches:

- Browse cached and uncached PDFs by collection, tag, title, author, year, and
  added date.
- Start parsing all visible files, only filtered files, or selected files.
- Repair local MinerU caches and synced packages when metadata or files drift.
- Delete all, filtered, selected, or single-item caches from the manager.
- Use tag filters, including automatic Zotero tags, to choose which papers are
  included in bulk actions.

Advanced parsing filters can skip files before automatic or bulk parsing:

- **Skip files over N pages** controls the maximum page count used by Start All,
  Start Filtered, Start Selected, and auto-parse. The default is 100 pages.
- **Exclude PDFs by Filename** accepts comma-separated substrings, or regex
  patterns wrapped in `/slashes/`, for translated copies, supplements, or other
  files you do not want parsed automatically.

If **Sync MinerU cache with Zotero file sync** is enabled, the plugin can create
companion ZIP attachments containing `full.md`, `manifest.json`,
`content_list.json`, and extracted assets. Existing local caches sync only when
you request it from the MinerU tab, and synced packages can restore a missing
local cache when needed.

</details>

<a id="webchat-setup-chatgpt-web-sync"></a>

## WebChat Setup (ChatGPT, DeepSeek & Gemini Web Sync)

WebChat mode sends questions to [chatgpt.com](https://chatgpt.com),
[chat.deepseek.com](https://chat.deepseek.com), and
[gemini.google.com](https://gemini.google.com) through a browser extension,
then streams responses back into Zotero. It is useful when you want browser
chat access without a provider API key.

<details>
<summary>WebChat prerequisites and setup</summary>

<p align="center">
  <img src="./assets/webchat.gif" alt="Screenshot of WebChat mode connected to chatgpt.com" width="1024" />
</p>

Prerequisites:

- Access to the selected provider site. Provider account requirements depend on
  the site and feature; Gemini permits some anonymous text conversations, while
  PDF upload and history may require sign-in.
- A Chromium-based browser such as Chrome.

Setup:

1. Download the latest `extension.zip` from
   [sync-for-zotero releases](https://github.com/yilewang/sync-for-zotero).
2. Unzip it.
3. Open `chrome://extensions`, enable **Developer Mode**, choose
   **Load unpacked**, and select the unzipped extension folder.
4. In Zotero, open `Preferences` -> `llm-for-zotero` and set
   **Auth Mode** -> `WebChat`.
5. ⚠️: Keep the selected provider tab open in your browser. A green dot in
   Zotero means the extension and that exact site are connected. Make sure the
   tab and Zotero stay in the same monitor. No minimization or backgrounding,
   or the connection may drop.

Gemini requires a companion extension version that explicitly advertises the
`gemini` target and DOM answer capture; Zotero rejects older extension builds
before dispatch. The canonical `gemini.google.com/app/:id` conversation path,
anonymous text flow, and signed-in PDF composer DOM have been observed in
Chrome. A complete automated Gemini PDF, follow-up, history, and restore run
remains required before a release is declared verified.

For release validation, keep Chrome signed in with the development extension loaded and run:

```bash
npm run test:webchat:live
```

This opt-in gate creates a real Zotero PDF fixture and clicks the real Zotero composer send control.
It verifies one exact PDF upload and answer, toggles the visible PDF chip both ways, then verifies one prompt-only turn with zero submitted PDFs through the relay and Chrome extension.

</details>

## FAQ

<details>
<summary><b>Does it require an API key to use this plugin?</b></summary>

It depends on the backend you choose. The plugin supports multiple backends with different requirements:

| Goal                                                        | Recommended path                                                              | API key required?               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------- |
| Use OpenAI, Gemini, DeepSeek, Moonshot, or another provider | Configure an API provider in Zotero preferences                               | Yes                             |
| Use a local model                                           | Connect any OpenAI-compatible local HTTP API                                  | Usually no                      |
| Use ChatGPT in the browser                                  | [WebChat](#webchat-setup-chatgpt-web-sync) with the Sync for Zotero extension | No                              |
| Use Codex models with ChatGPT Plus                          | [Codex App Server](#codex-setup-chatgpt-plus-subscribers)                     | No separate API key             |
| Use Claude Code inside Zotero                               | [Claude Code bridge](#claude-code-setup)                                      | Claude Code auth                |
| Search and read the current public web                      | [General Web Search](#general-web-search) with Tavily                         | Tavily API key                  |
| Improve PDF extraction for tables, equations, and figures   | [MinerU PDF parsing](#mineru-pdf-parsing)                                     | Personal MinerU key recommended |

</details>

> Is it free to use?

- Yes, the plugin is free. You only pay for API calls if you choose a paid
  provider. With Codex App Server, ChatGPT Plus subscribers can use Codex models
  without a separate API key. If you find this helpful, consider leaving a star
  on GitHub or [buying me a coffee](https://buymeacoffee.com/yat.lok).

<p align="center">
  <img src="https://github.com/user-attachments/assets/1e945e57-4b99-4d25-b8d5-fb120e100b62" width="200" alt="Alipay donation QR code">
</p>

<details>
<summary><b>Is my data used to train models?</b></summary>

The plugin does not train models. Data handling depends on the backend you
choose: your configured API provider, local model, WebChat, Codex, Claude
Code, or MinerU.

</details>

<details>
<summary><b>How do I report a bug or ask a question?</b></summary>

Please [open an issue](https://github.com/yilewang/llm-for-zotero/issues) on
GitHub.

</details>

## Privacy and Data Flow

Data flow depends on the backend you choose. Local models and local MinerU can
keep processing on your machine; cloud providers, WebChat, Claude Code, Codex,
and cloud MinerU involve their respective services or companion runtimes.

<details>
<summary>Detailed backend data flow</summary>

- In standard provider mode, paper content and user messages are sent to the
  model provider you configure.
- In local-model mode, requests go to the local OpenAI-compatible endpoint you
  configure.
- In WebChat mode, requests are relayed through the browser extension to
  `chatgpt.com` or `chat.deepseek.com`.
- When Tavily Web Search is configured, web queries and requested public URLs are sent to Tavily; the API key remains in local Zotero preferences.
- In cloud MinerU mode, newly added PDFs are sent to MinerU for parsing when
  parsing is enabled.
- In local MinerU mode, newly added PDFs are sent to the local or remote
  `mineru-api` server you configure.
- Conversation history and cached paper context are stored locally by the
  plugin.
- Agent Mode write operations are routed through reviewable actions and session
  undo where supported.

</details>

## Contributing

Contributions are welcome. Bug reports, feature requests, documentation
improvements, and pull requests are all useful. Please
[open an issue](https://github.com/yilewang/llm-for-zotero/issues) or submit a
PR.

## Roadmap

- [x] Agent mode (beta)
- [x] MinerU PDF parsing
- [x] GitHub Copilot auth
- [x] WebChat mode (ChatGPT, DeepSeek, and Gemini web sync)
- [x] Standalone window mode
- [x] File-based notes (Obsidian, Logseq, any Markdown directory)
- [x] Claude Code integration
- [x] Codex App Server integration
- [x] Local MinerU support
- [x] Customized skills
- [x] Cross-device synchronization (MinerU cache)
- [ ] Agent memory system
