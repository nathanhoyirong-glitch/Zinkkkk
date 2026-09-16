# Zinkk2

A diep.io-inspired multiplayer arena: square tanks, two 4-player rooms, and a spectate mode.
You always render as **red**; every opponent renders as **grey**.

## Features
- Two rooms ("Room 1" / "Room 2"), 4 players max each
- Spectate mode — watch either room without joining
- WASD to move, mouse to aim, click or Space to shoot
- Server-authoritative game loop (30 ticks/sec) so all clients stay in sync
- Health, kills/deaths, respawn on death

## Run it locally
```bash
npm install
npm start
```
Then open **http://localhost:3000** in a couple of browser tabs to test multiplayer against yourself.

## Project structure
```
zinkk2/
├── server.js        # WebSocket + game loop (rooms, physics, collisions)
├── package.json
├── public/
│   ├── index.html    # lobby + in-game HUD markup
│   ├── style.css      # dark arena UI theme
│   └── game.js         # WebSocket client, input handling, canvas rendering
└── README.md
```

## Deploying (e.g. on Render, same as the original Zinkk)
1. Push this repo to GitHub (see below).
2. On Render: **New → Web Service**, connect the GitHub repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Render sets `PORT` automatically — the server already reads `process.env.PORT`.

## Pushing this to GitHub
I can't push to GitHub directly from this chat (no GitHub connection is set up here), so do this from your machine after downloading the project:

```bash
cd zinkk2
git init
git add .
git commit -m "Initial commit: Zinkk2"
git branch -M main
git remote add origin https://github.com/<your-username>/zinkk2.git
git push -u origin main
```
(Create the empty `zinkk2` repo on GitHub first if it doesn't exist yet.)

## Ideas for next passes
- Smooth client-side interpolation between server ticks (currently snaps at 30fps)
- Power-ups / different tank shapes
- Persistent leaderboard
- Mobile touch controls (joystick + fire button)
