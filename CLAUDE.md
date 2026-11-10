# Resource queue maintenance

This repository contains a Pi Pocket drop-in extension, not a standalone server.

- Keep installable files in `resource-queue.ts` and `resource-queue/`. Do not add runtime dependencies outside Pi Pocket's packages and Node built-ins.
- Never test against the owner's live Pi Pocket data. Use temporary data with Pi Pocket's test helpers.
- Run `npm run check`, `npm test`, `npm run format:check`, then `npm run test:integration` before publishing.
- Integration tests use `POCKET_SOURCE` (default `../pocket-test-source`) for a Pi Pocket v0.27.0 checkout with dependencies installed.
- Local type checks need `_pocket.d.ts` linked to that checkout's `types/pocket.d.ts`. Install development dependencies into this repository's own `node_modules`; never run npm against a dependency symlink into a live installation.
- On this server, use `NODE_DISABLE_COMPILE_CACHE=1 TMPDIR=/var/tmp` for Node/npm checks. The default compile-cache path can hang.
- Keep `README.md`, the module's description, and gallery declarations accurate. Regenerate file hashes after every runtime change.
- Use independent review before submission. Publish only immutable commit IDs. Do not commit credentials, owner tokens, live settings, or session data.
