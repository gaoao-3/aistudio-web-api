# Fastify backend

The public HTTP server, browser capture/replay gateway, BotGuard integration, and native Gemini API request normalization, streaming parser, and AI Studio wire codec are implemented in TypeScript.
Google account onboarding supports both a local headed CloakBrowser window and
a headless, remotely assisted step flow; successful sessions are persisted as
Playwright storage state in the native account store.

## Windows startup

```powershell
pnpm install
.\start.ps1 -Port 3006
```

`start.ps1` uses this project's `data/` directory by default. Override that
location with `-RuntimeRoot` or the `AISTUDIO_RUNTIME_ROOT` environment
variable when an external runtime directory is intentional.

## Verification

```powershell
pnpm typecheck
pnpm test
pnpm build
```
