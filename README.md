# Zotero-LLM: Your Right-Hand Side AI Research Assistant

[![zotero target version](https://img.shields.io/badge/Zotero-8-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

![image](./assets/_neuron.png)

**Zotero-LLM** is a powerful plugin for [Zotero](https://www.zotero.org/) that integrates Large Language Models (LLMs) directly into the Zotero PDF reader. Unlike other tools that require you to upload your pdfs to a portal, this plugin is designed to conveniently access LLMs without the need to leave Zotero. It quietly sits in the panel of the Zotero reader, like your standby research assistant, ready to help you with any questions you have when reading a paper.

![image](./assets/demo.gif)

Key Features

- 🎨 Simple and elegant interface: Keep your attention on the paper rather than the tool.

- 🔑 Bring Your Own Key (BYOK): Connect directly to your preferred LLM provider. You pay only for what you use, with no middleman subscription fees. You can set up up to 2 LLM models to help me handle different types of tasks: for instance, the multimodal model for helping you to interpret the Figure; text-based model for helping you understand text. 

- Image input supported: You can do screenshot on the Figure and ask model for details. 

- 💬 Context-Aware Chat: Have a natural conversation with your PDF. The model has context of the paper currently open in your reader.

- ⚡ Quick-Action Presets: Use built-in prompts to instantly generate:
  - Summaries

  - Key Points (bulleted lists)

  - Methodology breakdowns

  - Limitations & Future Work analysis

  - All shortcuts are customizable.

- 📝 Seamless Integration: Lives inside the Zotero sidebar—no tab switching required.

![image](./assets/demo2.png)

### Installation

#### Step 1: Download the latest `.xpi` release

Download the latest `.xpi` release from the [Releases Page](https://github.com/yilewang/zotero-llm/releases).

Open `Zotero` and go to `Tools -> Add-ons`.

#### Step 2: Install the `.xpi` file

Click the gear icon and select `Install Add-on From File`

#### Step 3: Restart `Zotero`

Select the `.xpi` file and restart `Zotero` to complete the installation.

### Configuration

Open `Preferences` and navigate to the `Zotero-LLM` tab.

![image](./assets/api_setting.png)

Select your Provider (e.g., OpenAI, Gemini, Deepseek).

Paste your API Base URL, secret key and model name.

### Usage Guide

To chat with a paper, open any PDF in the Zotero reader.

Open the LLM Assistant sidebar (click the distinct icon in the right-hand toolbar).

Type a question in the chat box, such as "What is the main conclusion of this paper?"

### FAQ

> Q: Is it free to use?

A: Yes, absolutely free. You only pay for API calls, if you choose to use a paid API provider. If you think this tool is helpful, please consider supporting me with a star on GitHub or [buy me a coffee](https://buymeacoffee.com/yat.lok) .

> Q: Does this work with local models?

A: Yes! You can point the plugin to a local endpoint (like Ollama) to run models entirely offline for maximum privacy.

> Q: Is my data used to train models?

A: No. Since you use your own API key, your data privacy is governed by the terms of the API provider you choose (e.g., OpenAI Enterprise terms usually exclude training on API data).

> Q: If I have any questions, how to contact you?

A: Please feel free to open an issue on GitHub! I will try my best to help you.
