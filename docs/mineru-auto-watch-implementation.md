# MinerU Auto-Watch Implementation

## Overview

This document describes the implementation of the MinerU Auto-Watch feature, which automatically parses PDFs using MinerU when they are added to monitored Zotero collections.

## Architecture

### Core Components

```
┌─────────────────────────────────────────────────────────────────┐
│                      MinerU Auto-Watch                          │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   Notifier   │───▶│   Handler    │───▶│    Queue     │      │
│  │   Observer   │    │              │    │   Processor  │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│                                │                                │
│                                ▼                                │
│                       ┌────────────────┐                       │
│                       │  Collection    │                       │
│                       │  Checker       │                       │
│                       └────────────────┘                       │
│                                │                                │
│                                ▼                                │
│                       ┌────────────────┐                       │
│                       │   MinerU API   │                       │
│                       └────────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
New PDF added to Zotero
        │
        ▼
┌─────────────────┐
│ Zotero Notifier │
│ (item, add)     │
└────────┬────────┘
         │
         ▼
┌─────────────────────┐
│ handleItemNotification()
│ - Check if watched  │
│ - Get PDF attachments│
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  enqueueForProcessing()
│  - 3s debounce      │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│   processQueue()    │
│ - Parse with MinerU │
│ - Cache results     │
└─────────────────────┘
```

## File Structure

### New Files

| File                             | Purpose                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/modules/mineruAutoWatch.ts` | Core auto-watch module with Notifier integration, queue processing, and notification handling |

### Modified Files

| File                                 | Changes                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `src/utils/mineruConfig.ts`          | Added auto-watch configuration functions (get/set/add/remove collection IDs) |
| `src/hooks.ts`                       | Integrated startAutoWatch() on startup and stopAutoWatch() on shutdown       |
| `src/modules/mineruManagerScript.ts` | Added ⚡ toggle button in sidebar, status indicator, and hint text           |
| `addon/content/preferences.xhtml`    | Added auto-parse tip card above Manage Files section                         |
| `addon/prefs.js`                     | Added `mineruAutoWatchCollections` preference (default: empty string)        |

## Key Features

### 1. Zotero Notifier Integration

Listens for `item` type `add` events via `Zotero.Notifier.registerObserver()`:

```typescript
notifier.registerObserver(
  {
    notify(event: string, type: string, ids: unknown[]) {
      void handleItemNotification(event, type, ids);
    },
  },
  ["item"],
  "mineruAutoWatch",
);
```

### 2. Collection Hierarchy Support

When checking if an item should be processed, the system walks up the collection tree:

```typescript
async function isItemInWatchedCollection(
  item: Zotero.Item,
  watchedIds: Set<number>,
): Promise<boolean> {
  // Check direct collections and parent collections
  for (const colId of collectionIds) {
    if (watchedIds.has(colId)) return true;
    // Walk up the tree
    let currentId = colId;
    while (currentId > 0) {
      const col = Zotero.Collections.get(currentId);
      if (!col) break;
      const parentId = Number(col.parentID);
      if (watchedIds.has(parentId)) return true;
      currentId = parentId;
    }
  }
}
```

### 3. Debounced Processing Queue

Prevents excessive triggering during bulk operations (import, sync):

```typescript
const DEBOUNCE_MS = 3000;

function enqueueForProcessing(attachmentId: number, title: string): void {
  processingQueue.push({ attachmentId, title });

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void processQueue();
  }, DEBOUNCE_MS);
}
```

### 4. User Notifications

Uses `Zotero.ProgressWindow` for user feedback:

- **Processing**: Shows current item being parsed
- **Complete**: Shows number of successfully parsed PDFs
- **Rate Limited**: Shows pause notification when daily quota reached

### 5. UI Toggle Button

Each collection in the sidebar has a ⚡ toggle button:

- **Gold ⚡**: Auto-parse enabled for this collection
- **Gray ⚡**: Auto-parse disabled
- **Hover effect**: Scale up + full opacity
- **Click**: Toggles auto-watch state

## Configuration

### Preference Key

```javascript
pref("mineruAutoWatchCollections", "");
```

Storage format: Comma-separated collection IDs (e.g., "123,456,789")

### Public API

```typescript
// Add collection to watch list
addAutoWatchCollection(collectionId: number): void

// Remove collection from watch list
removeAutoWatchCollection(collectionId: number): void

// Check if collection is being watched
isAutoWatchCollection(collectionId: number): boolean

// Get all watched collection IDs
getAutoWatchCollectionIds(): Set<number>

// Start/stop auto-watch service
startAutoWatch(): void
stopAutoWatch(): void
```

## Error Handling

The implementation handles several error cases:

1. **MineruRateLimitError**: Pauses processing, shows notification, keeps item in queue
2. **MineruCancelledError**: Returns item to queue for retry
3. **Missing file path**: Skips item with log message
4. **Already cached**: Skips item to avoid re-processing

## Testing

### Manual Test Steps

1. **Enable Auto-Watch**:
   - Open Zotero Preferences → llm-for-zotero → MinerU
   - Click ⚡ icon next to a folder in the sidebar
   - Verify gold ⚡ appears and status shows "N folder(s) watching"

2. **Add PDF to Monitored Folder**:
   - Drag a PDF into the watched collection
   - Wait 3 seconds (debounce)
   - Verify notification appears: "MinerU Auto-Parse Complete"

3. **Verify Cache**:
   - Check that the item shows green dot in Manage Files list
   - Open the PDF in reader and verify MinerU content is used

4. **Disable Auto-Watch**:
   - Click gold ⚡ to disable
   - Verify gray ⚡ appears
   - Add another PDF and verify it is NOT auto-parsed

### Debug Logging

Enable debug logging in Zotero to see auto-watch activity:

```
Tools → Developer → Run JavaScript
ztoolkit.log("LLM: MinerU auto-watch debugging enabled")
```

Look for log messages:

- `MinerU auto-watch: started`
- `MinerU auto-watch: handling N added item(s)`
- `MinerU auto-watch: enqueuing [title]`
- `MinerU auto-watch: cached [title]`

## Future Improvements

1. **Batch Progress Indicator**: Show progress bar for multiple items
2. **Retry Logic**: Implement exponential backoff for failed items
3. **Filter by Tags**: Allow auto-watch based on item tags
4. **Time-based Rules**: Only auto-parse during certain hours
5. **Webhook Support**: Trigger external workflows on completion

## References

- [Feature Specification](../feature-mineru-auto-watch.md)
- [MinerU API Documentation](https://mineru.net)
- [Zotero Notifier API](https://developers.zotero.org)
