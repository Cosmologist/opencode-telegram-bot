# opencode-telegram-bot (fork)

Fork of [grinev/opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot).

## What's different

The original bot sends file edits as `.txt` attachments. This fork renders them as syntax-highlighted code blocks directly in chat.

- All `edit`/`write`/`apply_patch` results appear as text in chat, not files
- Language for syntax highlighting is detected from file extension (github-linguist map, 1478 entries)
- Long content (>4000 chars) is split into multiple messages
- Format: ` ```language\ncontent\n``` `

## Links

- Fork repo: https://github.com/Cosmologist/opencode-telegram-bot
- Author: https://github.com/Cosmologist
