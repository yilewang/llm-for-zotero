# Feature: MinerU Auto-Watch — Automatic PDF Parsing for Monitored Folders

## Overview

This feature allows users to select Zotero collections (folders) for automatic MinerU PDF parsing. When enabled on a folder, any new PDF added to that folder (or its sub-folders) will be automatically parsed by MinerU without manual intervention.

## How to Use

1. Open **Zotero Preferences** → navigate to the **llm-for-zotero** tab → click **MinerU**
2. In the "Manage Files" section, look at the **left sidebar** showing your folder tree
3. Each folder has a **⚡ icon** on the right side:
   - **Gray ⚡** = auto-parse disabled (click to enable)
   - **Gold ⚡** = auto-parse enabled (click to disable)
4. Click the ⚡ icon to toggle auto-parsing for that folder
5. Once enabled, any new PDF added to the folder will be automatically queued for MinerU parsing

> **Note:** A tip card at the top of the Manage Files section explains this feature.

## Architecture

### Files Modified

| File | Change |
|------|--------|
| `src/utils/mineruConfig.ts` | Added persistent read/write functions for auto-watch collection IDs |
| `addon/prefs.js` | Added `mineruAutoWatchCollections` default preference (empty string) |
| `src/hooks.ts` | Integrated `startAutoWatch()` / `stopAutoWatch()` into plugin lifecycle |
| `src/modules/mineruManagerScript.ts` | Added ⚡ toggle button in sidebar + hint text + import for config functions |
| `addon/content/preferences.xhtml` | Added auto-parse tip card above "Manage Files" section |

### Files Created

| File | Purpose |
|------|---------|
| `src/modules/mineruAutoWatch.ts` | Core auto-watch module — Zotero Notifier listener + auto-parse queue |

### Detailed Changes

#### 1. `src/utils/mineruConfig.ts` — Configuration Persistence

New functions for managing the set of auto-watched collection IDs:

- `getAutoWatchCollectionIds()` — Reads the comma-separated collection IDs from Zotero preferences and returns a `Set<number>`
- `setAutoWatchCollectionIds(ids)` — Serializes and saves the set
- `addAutoWatchCollection(collectionId)` — Adds a single collection to the watch list
- `removeAutoWatchCollection(collectionId)` — Removes a single collection
- `isAutoWatchCollection(collectionId)` — Checks if a collection is being watched

Storage key: `extensions.zotero.llmforzotero.mineruAutoWatchCollections`

#### 2. `src/modules/mineruAutoWatch.ts` — Core Module (New)

This is the main module implementing the auto-watch functionality:

- **Zotero Notifier Integration**: Registers an observer for `item` events (`add`/`modify`) via `Zotero.Notifier.registerObserver()`
- **Collection Hierarchy Support**: When a parent folder is watched, items added to any sub-folder are also auto-parsed (walks up the collection tree to check ancestors)
- **Processing Queue**: Maintains an internal queue of PDF attachments to parse, processed sequentially
- **3-second Debounce**: Prevents excessive triggering during bulk operations (import, sync)
- **Error Handling**: Gracefully handles rate limits (`MineruRateLimitError`) and cancellations (`MineruCancelledError`)
- **Public API**:
  - `startAutoWatch()` — Registers the Notifier observer (called on startup)
  - `stopAutoWatch()` — Unregisters the observer and clears the queue (called on shutdown)

#### 3. `src/hooks.ts` — Lifecycle Integration

- `onStartup()`: Calls `startAutoWatch()` (wrapped in try-catch) after webchat relay registration
- `onShutdown()`: Calls `stopAutoWatch()` before agent subsystem shutdown

#### 4. `src/modules/mineruManagerScript.ts` — UI Integration

- **⚡ Toggle Button**: Each collection node in the sidebar now has a ⚡ button
  - Gold with yellow background when active
  - Gray and semi-transparent when inactive
  - Hover effect: scale up + full opacity
  - Click toggles the auto-watch state and re-renders the sidebar
- **Sidebar Hint**: A text hint at the bottom of the sidebar shows:
  - How many folders are currently auto-parsing
  - Or a tip on how to enable auto-parsing
- **New imports**: `isAutoWatchCollection`, `addAutoWatchCollection`, `removeAutoWatchCollection`, `getAutoWatchCollectionIds`

#### 5. `addon/content/preferences.xhtml` — Tip Card

A styled info card above the "Manage Files" section with:
- Gold ⚡ icon
- Explanation text: "Click the ⚡ icon next to any folder in the sidebar below to enable automatic MinerU parsing..."

#### 6. `addon/prefs.js` — Default Preference

Added: `pref("mineruAutoWatchCollections", "");`

## Data Flow

```
New item added to Zotero
  → Zotero.Notifier fires "add" event for "item" type
  → mineruAutoWatch.ts handleItemNotification()
    → Check if item belongs to a watched collection (including ancestors)
    → If yes, find PDF attachments
    → Check if already cached (hasCachedMineruMd)
    → Enqueue for processing (3s debounce)
  → processAutoWatchQueue()
    → parsePdfWithMineruCloud() for each entry
    → writeMineruCacheFiles() on success
```
