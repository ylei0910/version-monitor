# Version Monitor — Claude Instructions

## Branching

- Always branch off `main` for any new feature work. Never commit new features directly to `main`. This avoids rebase conflicts when pushing feature branches.
- Branch naming: `feature/<short-description>` for features, `fix/<short-description>` for bug fixes.
- Merge back to `main` via pull request when the feature is complete.

## Versioning

- `VERSION` is bumped automatically by CI (`bump-version.yml`) on every merge to `main`. Do not manually edit `VERSION`.
- Do not update `VERSION` on feature branches — the bot handles it after merge.
- Version format: `MAJOR.MINOR.PATCH` (currently tracked in `./VERSION`).
