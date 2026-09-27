# Pokemon RPG - City League (playable slice)

This is a fork of [Pokemon Showdown](https://github.com/smogon/pokemon-showdown)'s
battle simulator, with a custom RPG layer built on top:

- `tiered-ai.mjs` - heuristic AI opponent with 4 difficulty tiers
- `stat-training.mjs` - the SP (stat point) training system
- `economy.mjs` - the held-item money system
- `battle-tracker.mjs` - shared fog-of-war state tracking
- `human-player.mjs` - the human side of a battle stream
- `game-server.mjs` - the HTTP game server (this is what you run)
- `public/` - the browser front end
- `regional-teams.json` / `regional-dex.json` - generated team/dex data per region

## Running it

No build step and no external npm dependencies are required to run the game
server itself - just Node 22+.

```
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  --import=./cjs-ts-shim.mjs --experimental-loader=./ts-resolve-loader.mjs \
  game-server.mjs
```

Then open `http://localhost:8090` (or whatever `$PORT` is set to) in a browser.

## Deploying (e.g. Render/Railway)

Set the service's start command to the command above (already set as the `web`
process in the `Procfile`), and make sure the platform provides `$PORT` as an
environment variable - `game-server.mjs` reads it automatically.
