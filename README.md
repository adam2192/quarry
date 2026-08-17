# QUARRY

A hunters-and-prey game for a group with phones. Everyone's location is
tracked live on the server, but the shared map only shows a "ping" of
positions on a timer (defaults to every 10 minutes) — separately
configurable for hunters and prey. Hunters tag prey by getting within a
set radius and tapping **Tag nearest prey**; the server checks the real
distance, not what's on screen.

No app install — it's a website. One person hosts the server, everyone
else just opens the link in a phone browser.

## Run it locally

```
npm install
npm start
```

Open `http://localhost:3000`. On the same wifi network, other players can
use `http://<your-computer's-LAN-IP>:3000` — but see the HTTPS note below
before you try to actually play with it.

## Important: you need HTTPS to play for real

Phone browsers only allow the location permission over a secure
connection (`https://`) or on `localhost`. `http://192.168.x.x:3000` will
look fine on your laptop and then silently fail to get GPS on everyone's
phone. You have two easy options:

**Deploy it** (recommended — takes a few minutes, gives you HTTPS for free):
- [Railway](https://railway.app) or [Render](https://render.com): connect
  the repo (or drag-and-drop upload), it'll detect `npm start` and give you
  an `https://…` URL automatically.
- [Fly.io](https://fly.io): `fly launch` then `fly deploy`.

**Tunnel your local server** (fastest for a one-off game night):
```
npx localtunnel --port 3000
```
or, if you have it, `ngrok http 3000`. Either gives you a temporary
`https://` URL that forwards to your laptop.

## How to run a game

1. Host opens the site, taps **Start a hunt**, gets a 4-letter room code.
2. Everyone else opens the same URL, taps **Join a hunt**, enters the code.
3. In the lobby, the host assigns who's a hunter vs prey (or hits
   **Shuffle roles**) and adjusts settings — ping interval, catch radius,
   head start, hunt length, and what happens when someone's caught.
4. Host taps **Start the hunt**. Everyone's phone starts sending its live
   location to the server in the background; nothing is shown to anyone
   until the first ping.
5. Positions reveal on the map when each timer fires (hunters and prey can
   have different intervals). A ripple animation marks a fresh ping so it's
   obvious the map just updated.
6. Hunters get a **Tag** button once in range of the nearest prey; the
   server verifies the real distance before it counts.
7. The hunt ends when time runs out, all prey are caught, or the host
   ends it manually.

## Notes on the settings

- **Reveal on catch** — if on, a tag also forces an immediate reveal of
  everyone, which tends to make the endgame more chaotic/exciting.
- **When a hunter catches prey** — *Flips* turns the caught player into
  another hunter (classic infection-tag), *Swaps* trades roles between
  catcher and caught, *Out* removes the caught player from the round.
- Locations are only ever shown to the room when a reveal fires — the
  server holds everyone's live position privately in between.

## Stack

Plain Node (Express + `ws`) on the backend, no build step on the
frontend — `public/` is served as static files, map tiles come from
OpenStreetMap via Leaflet. Nothing is persisted to disk; restarting the
server clears all rooms.
