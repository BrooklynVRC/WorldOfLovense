# WoW LovenseLink

Your Lovense toy (or any toy Intiface Central supports) reacts to **World of Warcraft Forever**: taking damage, low health, dying, crits, killing blows, level ups, quest turn-ins, rare/epic/legendary loot, honorable kills, boss pulls, kills and wipes.

There are two parts:

- **LovenseLink addon**: a normal WoW addon. When something happens, it shows a tiny 4-square colour strip in the top-left corner of the screen (32×8 pixels).
- **WoW-LovenseLink.exe**: reads that strip from the WoW window and drives your toy.

WoW addons cannot talk to other programs, so the event leaves the game as pixels on screen. The app only *reads* the window picture, the same way OBS or Discord screen share do. It never touches the game's memory or files and never sends keys or clicks.

## Setup

1. **Addon:** copy `addon/LovenseLink` into `World of Warcraft\_forever_\Interface\AddOns\`, then tick **LovenseLink** in the AddOns list on the character screen.
2. **App:** run `WoW-LovenseLink.exe`. Its window walks you through the rest:
   - **Lovense Remote:** connect your toy, turn on **Game Mode**, and enter its Local IP and Port in the app.
   - **Intiface Central** (other brands too): press **Start Server**, connect your toy, then pick Intiface in the app.
3. In WoW, type `/ll test`. Your toy should buzz, and the app should show "Test" as the last event.

WoW can be windowed or fullscreen and can sit behind other windows, but not minimized. Keep the top-left corner of the game free of overlays.

## Slash commands

| Command | Does |
| --- | --- |
| `/ll test` | sends a test event |
| `/ll off` | pauses the addon (remembered across sessions) |
| `/ll on` | turns it back on |

The big **STOP** button in the app stops the toy immediately. Closing the app also stops it.

## Events

| Event | Default | Notes |
| --- | --- | --- |
| Taking damage | on | strength scales with how much of your health the hits took (added up over half a second, ignored under 2%) |
| Low health | on | under 25%, re-arms above 40% |
| You died / Killed by a player | on | "by a player" when a player hit you in the last 5 seconds |
| Crit | on | at most once a second |
| Killing blow, Honorable kill | on | |
| Level up, Quest turned in | on | |
| Loot rare / epic / legendary | on | only your own loot |
| Boss pulled / killed / Wipe | on | dungeon and raid encounters |
| Entering / leaving combat, Resurrected | off | |

Every event has its own action (constant, preset, or custom pattern; strength 0–20; duration) under **3. What happens in the game**, plus global safety limits.

## Development

```
cd app
npm install
npm run build:host   # the window + capture helper (needs the .NET 8 SDK)
npm start            # http://localhost:7703
npm test
npm run package      # release/WoW-LovenseLink.exe
```

Strip format (see `addon/LovenseLink/LovenseLink.lua`): magenta marker, then `R = sequence, G/B = event code`, then `R = intensity` with two check channels, then a cyan marker. Each channel uses 16 levels (×17), so small colour shifts don't matter.
