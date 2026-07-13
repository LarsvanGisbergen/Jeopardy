# Local Jeopardy Suite

Local-first Jeopardy hosting toolkit with two modes:
- **Build**: Create and validate game packs (`Draft`, `Ready`, `Archived`)
- **Play**: Host a Jeopardy-style round with teams, scoring, and Daily Double markers

Everything runs locally and stores data as JSON files under `data/packs`.

## Requirements

- Node.js 20+

## Run (Browser)

```powershell
node server/index.js
```

Then open:

- [http://localhost:8787/build](http://localhost:8787/build) for builder
- [http://localhost:8787/play](http://localhost:8787/play) for game host mode

## Friend Distribution (Windows)

Create a single portable executable and share just that file:

- `release\Local Jeopardy Suite <version>.exe`

For friends, usage is simply:

1. Double-click the `.exe`
2. Play

## Data Model

Each pack is stored in `data/packs/<id>.json`:

- `id`, `title`, `status`, `createdAt`, `updatedAt`
- `board.rows`, `board.cols`, `board.categories[]`
- Category: `name`, `clues[]`
- Clue: `question`, `answer`, `value`, `dailyDouble`
- `settings.eliminationRound.questions[]`

`data/index.json` stores lightweight list metadata for fast listing.

## API

- `GET /api/packs`
- `POST /api/packs`
- `GET /api/packs/:id`
- `PUT /api/packs/:id`
- `POST /api/packs/:id/validate`
- `POST /api/packs/:id/status`

Status change to `ready` is blocked until validation passes.

## Validation Rules

`Ready` requires:
- non-empty pack title
- positive integer `rows` and `cols`
- exactly `cols` categories
- each category has a non-empty name
- each category has exactly `rows` clues
- each clue has non-empty `question` and `answer`
- each clue has a positive numeric `value`

Warnings (non-blocking):
- duplicate category names

## Notes

- Editing is local JSON only; no internet dependency at runtime.
- `Play` only lists packs with status `ready`.
- A game session (used clues + scores) is in browser memory and resets on reload.
