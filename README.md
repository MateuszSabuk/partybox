# PartyBox

Portable party-game hub for a Raspberry Pi 5. The Pi (or a small AP wired to it) provides the Wi-Fi,
the TV shows two QR codes (Wi-Fi + game URL), phones are the controllers.

```
npm install
npm start                      # http://localhost:8080/host  = TV screen,  http://<ip>:8080/ = phones
npm test                       # 46-check simulation: 12 phones, reconnect, scores, persistence, avatars
npm run test:browser           # real Chromium: join, photo framing, avatars on TV, full game, emoji scan (needs Playwright)
```

## How it fits together

- **One token, one socket.** `POST /api/join` creates a session `{id, token}` and sets a `pb_token`
  cookie; the phone also keeps it in localStorage. The same token authenticates the lobby and every game,
  so switching games never asks for a login. A phone that reloads, locks its screen or loses Wi-Fi
  reconnects with the token and is sent a **snapshot** of the current game state.
- **Leader.** The first connected player picks and starts games from their phone (`lobby.leaderCanControl`).
  The host screen can always do it (click a game twice, or Enter / Esc).
- **Scores** live in the session, so they carry across games.
- **Avatars.** Every player gets a personal colour (evenly spread hues) and a silhouette. In the lobby they can tap
  their picture any time to choose or take a photo, drag/pinch it inside a circular frame, and save; or remove it again.
  The phone sends a ~10 KB 192x192 JPEG to `POST /api/avatar` (token in header or cookie). The server accepts only JPEG
  up to 64 KB and 512x512 (checked from the header, nothing is decoded), rate-limits to 1/s, stores it in
  `data/avatars/`, and serves it as `/avatar/<id>.jpg?v=<revision>`. It is deleted when the player is kicked/reset.

## Adding a game (modular)

Create `games/<id>/` — it appears in the lobby on the next lobby refresh, no other file changes:

```
games/my-game/
  game.json          { "id": "my-game", "name": "...", "description": "...", "icon": "icon.svg", "minPlayers": 2, "maxPlayers": 12 }
  client/icon.svg    the lobby icon ("icon" = file name in client/, .svg/.png/.webp; omitted -> generic pad icon)
  server.js          export default function create(ctx) { return { start, snapshot, hostSnapshot, onMessage, ... } }
  client/player.js   export function mount(root, api) { return { message(d, isSnapshot), unmount() } }
  client/host.js     export function mount(root, api) { return { message(d, isSnapshot), unmount() } }
```

`games/tap-race/` is a fully commented reference. Rules of the contract:

| Server `ctx` | Meaning |
|---|---|
| `ctx.config` | per-game section from `config.json` → `games.config.<id>` |
| `ctx.players()` | `[{id,name,score,on,away}]` – same ids as the lobby |
| `ctx.send(id,d)` / `ctx.sendAll(d)` / `ctx.sendHost(d)` | message one phone / all phones / the TV |
| `ctx.setTimeout` / `ctx.setInterval` / `ctx.clear` | timers that are cleaned up automatically |
| `ctx.endGame(points, summary)` | add `{playerId: points}` and return to the lobby |

Hooks (all optional): `start`, `snapshot(player)`, `hostSnapshot()`, `onMessage(player,d)`, `onHostMessage(d)`,
`onPlayerJoin/Disconnect/Reconnect/Away(player)`, `destroy`.
**`snapshot()` must describe the complete current state** – it is what makes mid-game reconnects work.
Client `api`: `send(d)`, `me`, `players()`, `orientation('portrait'|'landscape'|'any')`, `latency()`, and
`ui` = `{ avatar(player,size), medal(rank,size), gameIcon, icons, esc }`.
**Don't use emoji in games**: many TV/Linux browsers have no emoji font (you get empty boxes or flat outline
symbols). Use `api.ui.avatar()` / `api.ui.medal()` / your own SVG. `setup.sh` also installs `fonts-noto-color-emoji` as a safety net.

## Config reference

Copy `config.example.json` to `config.json`; anything omitted uses the default. Env overrides:
`PARTYBOX_CONFIG`, `PARTYBOX_HTTP_PORT`, `PARTYBOX_HTTPS_PORT`, `PARTYBOX_DATA_DIR`, `PARTYBOX_SSID`, `PARTYBOX_WIFI_PASSWORD`, `PARTYBOX_DOMAIN`.

| Key | Default | Purpose |
|---|---|---|
| `wifi.ssid` / `password` / `security` / `hidden` | PartyBox / letsplay123 / WPA / false | Used only to draw the Wi-Fi QR – the real AP is set up in the OS |
| `network.ip` | 192.168.4.1 | Pi address on the party network |
| `server.httpPort` / `httpsPort` | 8080 / 8443 | Use 80 / 443 on the Pi |
| `server.domain` | "" | Your domain; the Pi's DNS must resolve it to `network.ip` |
| `server.publicUrl` | "" | Full override of the URL in the join QR |
| `server.tls.enabled` / `cert` / `key` / `redirectHttp` | false / "" / "" / true | HTTPS with your domain's certificate |
| `players.max` | 12 | Hard cap on sessions |
| `players.nameMaxLength` | 16 | |
| `players.graceSeconds` | 90 | Dropped player shows "reconnecting", then "away" |
| `players.sessionTtlHours` | 12 | Token forgotten this long after last seen |
| `players.heartbeatSeconds` | 5 | Server ping interval |
| `lobby.leaderCanControl` | true | First player picks/starts games |
| `lobby.hostPin` | "" | Remote host screens must add `?pin=` (the Pi itself is always trusted) |
| `lobby.allowJoinDuringGame` | true | |
| `games.dir` / `games.enabled` | games / [] | `[]` = all valid game folders |
| `games.config.<id>` | – | Passed to the game as `ctx.config` |
| `data.dir` / `persistSessions` | data / true | Sessions survive a Pi restart |
| `limits.maxMessageBytes` / `messagesPerSecond` | 4096 / 40 | Per-socket abuse protection |

## Setting up the Pi (scripts/)

Target: Raspberry Pi 5, Raspberry Pi OS **Bookworm or newer** (NetworkManager). Copy this folder to the Pi, then:

```bash
sudo ./scripts/setup.sh --dry-run --domain party.example.com --country PL    # read what it will do first
sudo ./scripts/setup.sh            --domain party.example.com --country PL --ssid PartyBox --password letsplay123
sudo reboot                                                                  # hotspot starts on the next boot
```

| Script | Purpose |
|---|---|
| `setup.sh` | One-shot installer: Node 22, app in `/opt/partybox` (own `partybox` user), config in `/etc/partybox/config.json`, systemd service on :80/:443, hotspot + DNS, TV kiosk. Re-runnable. Options: `--mode wifi\|ethernet`, `--band bg\|a`, `--channel`, `--no-kiosk`, `--no-network`, `--dry-run` (see `--help`). |
| `install-cert.sh fullchain.pem privkey.pem [domain]` | Verifies the cert (key matches, covers the domain, expiry), installs it, enables HTTPS, restarts. Use again to renew. |
| `doctor.sh [--watch]` | Health check (service, ports, probes, DNS, AP, country, power). `--watch` = live count of phones on the Wi-Fi – **use it for the 12-phone test.** |
| `readonly.sh on\|off` | Optional overlay filesystem so you can pull the plug safely (sessions then reset every boot). |
| `uninstall.sh [--purge]` | Removes service, hotspot profile, DNS rules, kiosk autostart. |
| `kiosk.sh` | Started at login by setup.sh; opens `http://localhost/host` full-screen, restarts Chromium if it dies. |

Design notes:
- **Nothing switches during setup.** The hotspot profile is created but only starts on reboot, so an SSH session over Wi-Fi isn't cut. After that the Pi's radio is the hotspot – use Ethernet for internet/SSH.
- **`--mode ethernet`** is the "dedicated access point" path: the Pi serves DHCP/DNS on `eth0` and a travel router in *Access Point/bridge mode* (its own DHCP off) provides the radio. Give the router the same SSID/password you pass to setup, so the Wi-Fi QR on the TV is correct.
- **Phones' "no internet" probes** (Android/iOS/Windows/Firefox hostnames) are pointed at the Pi, which answers them correctly, so phones stay on the party Wi-Fi without popups. They also aren't redirected to https.
- **Wi-Fi country** (`--country`) must be set or the radio may refuse to start / 5 GHz is unavailable. Default is PL.
- The Pi's own TV browser always uses plain `http://localhost` – it needs no certificate, DNS or internet.

## HTTPS with your domain

1. Get a certificate for e.g. `party.example.com` (DNS-01 challenge works without exposing the Pi). Let's
   Encrypt certs last 90 days – renew before an event while you have internet.
2. `sudo ./scripts/setup.sh --domain party.example.com …` (adds the DNS rule `address=/party.example.com/192.168.4.1`)
3. `sudo ./scripts/install-cert.sh fullchain.pem privkey.pem`
4. Phones use `https://party.example.com/`; HTTPS unlocks the Wake Lock API (screen stays on) and
   motion sensors on iOS. The Pi's own TV browser keeps using `http://localhost`.

## Known limits (honest list)

- iPhone Safari has no Fullscreen API – only "Add to Home Screen" gives a chrome-less view (a hint is shown).
- Orientation lock only works in fullscreen on Android Chromium.
- **The setup scripts are untested on real hardware** (written without a Pi/NetworkManager at hand). The config
  generator, certificate checks, HTTPS/redirect logic and `--dry-run` output were tested; the `nmcli`, kiosk
  autostart and `raspi-config` steps were not. Run `setup.sh --dry-run` first and report anything that fails.
- Screen blanking on the TV must be disabled by hand (raspi-config → Display Options).
- Not yet built: audio, a second real game.
- Test 12+ phones on the Pi's built-in Wi-Fi before relying on it; otherwise use an external AP.
