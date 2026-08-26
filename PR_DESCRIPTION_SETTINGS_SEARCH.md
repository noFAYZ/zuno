## What and why

Adds a global Settings search field. It searches setting titles and descriptions across every Settings category, shows matching results with their category, and opens the selected category. The Settings layout now responds to the Settings pane width with container queries: narrow panes stack the header, make the search field full width, and turn the vertical category sidebar into a horizontal scrollable rail so settings cards retain usable content width.

## How it was checked

- [x] `npm run verify` passes — 33 checks passed
- [x] `cargo test` not required — no `src-tauri/` files changed
- [x] `npm run build` passes
- [x] Search check covers empty, multi-term, category, and no-match queries
- [ ] Screenshot or clip below (UI changes)

## Notes for the reviewer

- Search metadata is isolated in `src/ui/components/settingsSearchIndex.ts`; the page component only owns query state and category navigation.
- The compact layout is a named container query, not a viewport breakpoint. It responds correctly when Settings is constrained by application chrome, window scaling, or an embedded pane.
- Selecting a search result clears the query and opens its category.
