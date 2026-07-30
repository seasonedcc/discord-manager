import {
  addBookmarkByLinkSchema,
  listBookmarksSchema,
  resolveBookmarkSchema,
  snoozeBookmarkSchema,
} from '~/business/bookmarks.common'
import {
  addBookmarkByLink,
  listBookmarks,
  resolveBookmark,
  snoozeBookmark,
} from '~/business/bookmarks.server'
import type { McpTool } from '~/mcp/tool'

const bookmarksTools: McpTool[] = [
  {
    name: 'bookmarks_add',
    description:
      'Bookmark a message from its Discord link, exactly as reacting to it with 🔖 would.',
    inputSchema: addBookmarkByLinkSchema,
    wraps: ['bookmarks.addBookmarkByLink'],
    execute: (input, context) => addBookmarkByLink(input, context),
  },
  {
    name: 'bookmarks_list',
    description:
      'Read the bookmarks still waiting on you, newest first, and optionally the snoozed ones too.',
    inputSchema: listBookmarksSchema,
    wraps: ['bookmarks.listBookmarks'],
    execute: (input, context) => listBookmarks(input, context),
  },
  {
    name: 'bookmarks_resolve',
    description:
      'Clear a bookmark you have dealt with, leaving the 🔖 reaction in Discord untouched.',
    inputSchema: resolveBookmarkSchema,
    wraps: ['bookmarks.resolveBookmark'],
    execute: (input, context) => resolveBookmark(input, context),
  },
  {
    name: 'bookmarks_snooze',
    description:
      'Keep a bookmark out of the default list until the moment you pick, then let it come back.',
    inputSchema: snoozeBookmarkSchema,
    wraps: ['bookmarks.snoozeBookmark'],
    execute: (input, context) => snoozeBookmark(input, context),
  },
]

export { bookmarksTools }
