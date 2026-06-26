# PDF Figure Runtime Release

The normal plugin release workflow still runs from `v*` tags and publishes the XPI.

The PDF figure extraction runtime is released separately from the manual `Release PDF Figure Runtime` workflow.
That workflow builds six ZIP files and uploads them to the fixed GitHub release tag `pdf-figure-runtime-v1`.

The plugin downloads runtime assets from this pattern:

```text
https://github.com/yilewang/llm-for-zotero/releases/download/pdf-figure-runtime-v1/llm-for-zotero-pdf-figure-runtime-v1-{platform}.zip
```

The current platform assets are:

```text
llm-for-zotero-pdf-figure-runtime-v1-macos-arm64.zip
llm-for-zotero-pdf-figure-runtime-v1-macos-x64.zip
llm-for-zotero-pdf-figure-runtime-v1-linux-arm64.zip
llm-for-zotero-pdf-figure-runtime-v1-linux-x64.zip
llm-for-zotero-pdf-figure-runtime-v1-windows-arm64.zip
llm-for-zotero-pdf-figure-runtime-v1-windows-x64.zip
```

Run the workflow manually after changing `PDF_FIGURE_RUNTIME_VERSION`, the runtime packaging script, or the Python/Poppler dependency set.

Use `publish_release=false` for a dry run that only uploads workflow artifacts.
Use `publish_release=true` to create or update the `pdf-figure-runtime-v1` GitHub release assets.

The `windows-arm64` asset currently packages the Windows x64 conda runtime under a `windows-arm64` manifest.
This relies on Windows ARM x64 emulation and keeps the plugin's default Windows ARM runtime URL populated until a complete native conda-forge Windows ARM scientific stack is available.
