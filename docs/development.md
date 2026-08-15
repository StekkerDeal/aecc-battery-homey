# Development

How to work on this app locally.

## Prerequisites

- Node.js 24 or newer
- A Homey (this app targets firmware 12.13.0 or newer) reachable on the same
  network as your development machine
- The Homey CLI: `npm i -g homey`

## First-time setup

```
npm install
homey login
homey select
```

`homey login` authenticates the CLI against your Athom account.
`homey select` picks which of your Homeys the CLI targets for `run`,
`install` and `validate`.

## Running the app

```
npm run dev
```

This runs `homey app run --remote`. `--remote` builds the app and runs it
**on the Homey itself**, streaming logs back over the network, rather than
running the app locally and having the Homey connect out to your machine.
That is the practical choice on Windows: the local (non-remote) run mode
depends on Docker's `--network host`, which Docker Desktop on Windows only
partially supports, so devices on your LAN are frequently unreachable from
inside the container. `--remote` sidesteps that entirely since the code
executes on the Homey, which is already on the same network as the battery.

## Local gate

```
.\scripts\check.ps1
```

Runs the same checks as CI, in order: `format:check`, `lint`, `typecheck`,
`test`, then `homey app validate --level publish`. Run this before pushing;
it is the fastest way to catch what CI would catch. Pass `-Fast` to skip the
`homey app validate` step (slower, needs the CLI logged in) while iterating.

## `.homeycompose` and `app.json`

`app.json` is a **generated, committed file**. Never hand-edit it. Instead,
edit the source files under `.homeycompose/` (app metadata, driver
definitions, flow cards, capabilities) and run:

```
npx homey app build
```

which regenerates `app.json` from the compose sources. CI has a
`compose-drift` job that rebuilds `app.json` and fails if the committed copy
does not match, so a stale `app.json` from an unbuilt compose edit is caught
before merge, not after.

## Release flow

Releases are two separate, manually dispatched GitHub Actions workflows,
never a push to `main`:

1. **Version** (`.github/workflows/version.yml`): dispatched by hand with a
   bump type (`major`/`minor`/`patch`) and a changelog entry. Bumps the app
   version, commits, and tags.
2. **Publish** (`.github/workflows/publish.yml`): dispatched by hand
   afterwards. Builds and submits the tagged version to the Homey App Store.

Publishing is never automatic on merge; both steps require a maintainer to
trigger them deliberately.

## Tests

Tests run under Vitest (`npm test` / `npm run test:watch` /
`npm run coverage`) and must never require real hardware. Mock the Homey SDK
(see `test/mocks/homey.ts`) and the battery's TCP responses rather than
connecting to a live device; a test suite that only passes with a battery on
the network is not something CI, or another contributor, can run.
