# Alexa Control for Touch Portal

Control your Amazon Echo devices from Touch Portal buttons and sliders: speak and announce, "Tell Alexa" any phrase, media control, volume, Do Not Disturb, routines, timers and smart home on/off. The plugin runs on your Windows PC. Your phone or tablet only shows the Touch Portal pages.

There are two backends. You can use either or both:

| Backend | What it is | What it can do |
|---|---|---|
| **Alexa (alexa-remote2)** | Unofficial. Logs in to your Amazon account the same way the Alexa app does. | Everything in this README. |
| **Voice Monkey** | Official, paid tiers, limited. Uses the Voice Monkey v3 API. | Announcements and triggering routines through Voice Monkey devices. |

If one backend fails or is turned off, the other keeps working. Problems show up in the plugin's states, never as a crash.

> **Important:** the Alexa backend uses an unofficial, reverse engineered Amazon API through the open source library [alexa-remote2](https://github.com/Apollon77/alexa-remote). Amazon does not support it and can change things at any time. When that happens, parts of the plugin can stop working until the library is updated. Voice Monkey is the official fallback.

## Project status (version 1.4.1, October 2026)

This is an early release. It has been tested on one setup: Windows with Touch Portal 4.4.3, Node 20.20, a US Amazon account, one Echo Dot, Roku TVs and smart plugs added through the Alexa app. Here is exactly what has and has not been checked on real hardware.

**Works on real hardware**

- Importing the plugin, pairing with Touch Portal, and the Amazon login page (including the **Open Amazon login page** action).
- The saved login surviving Touch Portal restarts and plugin updates.
- Loading the Echo, routine and smart home device lists.
- **Smart home device on, off or toggle** with **On** and **Off**, sent through a real Echo.
- **Smart home device volume up or down** on Roku TVs. Each tap is one Roku step (5). Some taps were accepted by Amazon but never reached the TV, which looks like a Roku-side problem.

**Known problems**

- **Toggle** for smart home devices does not work yet: the plugin cannot read whether the device is on or off. Use separate On and Off buttons.
- Commands sent "through" a speaker group (such as *Everywhere*) did nothing. Pick a real Echo.
- The volume actions only work on Echos that report their volume to Amazon. Fire TV devices in the Echo list do not.
- Amazon rate limits commands sent about a second apart. Press slowly.
- The **Alexa connection** setting can keep showing *Connecting...* until Touch Portal is restarted, even though the plugin is connected.

**Not tested on real hardware yet** (covered by automated tests only)

- Speak and Announce, media controls, Set volume and Volume up or down on an Echo, the volume slider.
- Do Not Disturb, routines, timers.
- The Voice Monkey backend.
- Amazon regions other than the US.
- The 1.4.1 changes: spacing out device volume taps and dropping rate-limited taps.

---

## Requirements

- Windows 10 or 11 with **Touch Portal 4.3 or newer** (the plugin uses Touch Portal API 10).
- **Node.js 20.15 or newer** installed and on your PATH. Check by opening a Command Prompt and typing `node -v`.
- An Amazon account with Echo devices.
- Optional: a Voice Monkey account (voicemonkey.io).

## Install

1. In Touch Portal, open **Settings (gear icon) > Plug-ins > Import plug-in**.
2. Pick `AlexaControl.tpp` and confirm. Touch Portal asks whether to trust the plugin. Choose **Trust Always**.
3. Restart Touch Portal if it asks you to.
4. Open **Settings > Plug-ins**, choose **Alexa Control**, and check the settings:
   - **Amazon region**: the Amazon site your Alexa account uses (for example `United States (amazon.com)`).
   - **Alexa backend enabled**: On.
   - Leave **Login proxy address** at `127.0.0.1` and **Login proxy port** at `3456` unless you have a reason to change them.
5. Click **Save**.

The plugin does not need a separate `npm install`. Everything it needs is inside the .tpp file.

## First Amazon login

The plugin never asks for your Amazon password. Instead, it starts a small temporary login page on your PC and you sign in to Amazon through it, just like in the Alexa app. That lets you complete two-step verification and captchas normally.

1. After saving the settings, make a button with the action **Open Amazon login page** (under Alexa Control > Plugin and login) and press it. The Amazon login page opens **in the default browser on the PC** running Touch Portal, not on your tablet.
   You can also open the address yourself: it is shown in the state **Alexa login URL** (a state, so it appears in a button's text or state picker, not on the settings page) and in the plugin log. By default it is `http://127.0.0.1:3456/`, which only works in a browser on the PC.
2. Sign in on the PC. Avoid using a device that has the Alexa app installed, otherwise Amazon may try to open the app instead.
3. Sign in to Amazon and complete any verification steps.
4. When the page says the cookie was retrieved, you can close the browser tab. **Alexa connection** changes to `Connected`, and the device, routine and smart home lists fill in.

The login is saved to `%APPDATA%\AlexaControl-TouchPortal\alexa-auth.json` (outside the plugin folder, so re-importing or updating the plugin does not log you out) and reused every time Touch Portal starts. The library refreshes it automatically every few days. You should not need to log in again unless Amazon ends the session.

The plugin **never retries a failed login on its own**, because repeated logins can get an account blocked. Only network errors (for example, the PC was offline at startup) are retried, slowly: after 1, 5 and 15 minutes, and then it stops. Use the **Reconnect to Amazon** action to try again by hand.

## Am I connected?

Open **Settings > Plug-ins > Alexa Control**. The line **Alexa connection** at the top shows:

| Value | Meaning |
|---|---|
| `Connected` | Everything works. |
| `Connecting...` | The plugin is starting or reconnecting. |
| `Disconnected: Amazon login needed` | Press a button with **Open Amazon login page**, or click **Open login page** in the Touch Portal notification, and sign in on the PC. The address is also shown in **Amazon login page**. |
| `Disconnected: <reason>` | Something failed. Use **Reconnect to Amazon**, or see Troubleshooting. |
| `Off` | **Alexa backend enabled** is off. |

The settings page shows the value from when you opened it; close and reopen it to refresh. When a login is needed, Touch Portal also shows a notification (bell icon) with an **Open login page** button.

## Adding buttons

All actions are in the action list under **Alexa Control**, grouped into sub categories:

| Sub category | Action | What it does |
|---|---|---|
| Speech | **Speak or announce text** | `Speak` says the text on one Echo (or on every Echo, one after another). `Announce` plays an Alexa announcement (with the chime) on one or all Echos at once. |
| Speech | **Tell Alexa (any phrase)** | Sends a phrase as if you had said it to that Echo, for example `play jazz on spotify` or `what's the weather`. |
| Media and volume | **Media control** | Play, Pause, Next, Previous on one Echo. Works when that Echo has a music session. |
| Media and volume | **Set volume** | Sets an exact volume (0 to 100) on one or all Echos. |
| Media and volume | **Volume up or down** | Changes the volume by a step. |
| Routines, timers and DND | **Do Not Disturb** | On, Off or Toggle, on one or all Echos. Toggle reads the current state first; on All Echos it turns everything off if any Echo has it on, otherwise everything on. |
| Routines, timers and DND | **Run a routine** | Runs one of the routines from your Alexa app. Pick the Echo it should run on. |
| Routines, timers and DND | **Create timer** | Starts a timer (minutes, decimals allowed, optional name). |
| Routines, timers and DND | **Cancel all timers** | Cancels the timers on that Echo. |
| Smart home | **Smart home device on, off or toggle** | Turns a smart home device on or off by asking Alexa through the chosen Echo. Toggle asks Amazon whether the device is on first; if the device does not report that, it flips the last state this plugin set, and if there is none it asks you to use On or Off once. |
| Smart home | **Smart home device volume up or down** | Turns a smart home device's volume up or down (for example a Roku TV) by asking Alexa through the chosen Echo, like saying "turn up the volume on Living Room Roku". Alexa picks the step size (Roku: 5 per tap; "by N" is ignored). Taps are sent at least 2 s apart, at most 3 wait in line, and a tap in the other direction clears the line. A tap Amazon rate limits is dropped, not sent late. Volume commands for Roku do not work while Netflix is open. |
| Plugin and login | **Refresh lists from Amazon** | Reloads Echos, routines and smart home devices. Use it after you add a device or routine in the Alexa app. |
| Plugin and login | **Open Amazon login page** | Opens the Amazon login page in the browser on the PC. If no login is waiting, it reconnects first and opens the page if Amazon asks for a login. Does nothing (and says so in the last error state) when you are already signed in. |
| Plugin and login | **Reconnect to Amazon** | Reconnects using the saved login. |
| Plugin and login | **Sign in to Amazon again** | Forgets the saved login and starts a new browser login. |
| Voice Monkey | **Voice Monkey announce** | Announcement on a Voice Monkey Speaker device. |
| Voice Monkey | **Voice Monkey trigger routine** | Fires a Voice Monkey Routine Trigger device. |

The drop-down lists (Echos, routines, smart home devices) are filled by the plugin once it is connected. If a list shows `(none)`, the plugin is not connected yet, or run **Refresh lists from Amazon**.

**Good to know:**
- Timers and "cancel all timers" are sent as spoken style commands ("set a timer for 5 minutes"). The library has no working direct way to set a timer length.
- Smart home on/off works the same way ("turn on Desk Lamp"), so it works for any device Alexa can control by voice.
- If you rename an Echo in the Alexa app, run **Refresh lists from Amazon** and pick it again in your buttons.

## Adding a volume slider

1. Add a **Slider** control to a page.
2. In the slider's settings, choose the connector **Alexa Control > Echo volume**.
3. Pick the Echo in the drop down.

Moving the slider sets that Echo's volume. Only the final position of a drag is sent to Amazon. When the volume changes elsewhere (by voice, in the app), the slider moves to match, as long as the push connection is up or the next poll has run.

## States you can show on buttons

| State | Meaning |
|---|---|
| Alexa connection | `Disabled`, `Connecting`, `Login required`, `Connected` or `Error`. The event **Alexa connection changes** fires on these. |
| Alexa status message | A readable description of what is going on. |
| Alexa login URL | The address to open when a login is needed. Empty otherwise. |
| Alexa Control last error | Time and text of the most recent failure. |
| Alexa push connection | Whether Amazon's live update connection is up. |
| Number of Echo devices found | Count of Echos in the lists. |
| Voice Monkey status | Ready, OK, rate limited, errors. |
| `<Echo name> volume` | Per Echo, created automatically, grouped as "Alexa: <Echo name>". |
| `<Echo name> now playing title` / `artist` / `player state` | Per Echo. |

**Now playing and volume updates:** while the push connection is up, Amazon tells the plugin when something changes and the plugin then fetches the details. When the push connection is down, the plugin polls one Echo every 5 seconds (only when no button press is waiting) and all volumes once a minute.

## Voice Monkey setup

1. Create an account at voicemonkey.io and enable the Voice Monkey skill in your Alexa app.
2. In the Voice Monkey console, open **API Tokens**, create a token (name it "Touch Portal"), and copy it.
3. Create the devices you want to use:
   - a **Speaker** device for announcements
   - a **Routine Trigger** device for each routine, then add it as the "When" of a routine in the Alexa app
4. In Touch Portal, open **Settings > Plug-ins > Alexa Control**, set **Voice Monkey enabled** to On, paste the token into **Voice Monkey token**, and click **Save**.
5. In the Voice Monkey actions, type the device ID exactly as shown in the Voice Monkey console.

The voice (for example `Joanna` or `Brian`) and the chime (a soundbank URL such as `soundbank://soundlibrary/alarms/air_horns/air_horn_01`) are optional. The Voice Monkey Playground lists all voices and chimes.

If Voice Monkey answers "too many requests" (HTTP 429), the plugin waits and retries up to 4 times with growing delays (1, 2, 4, 8 seconds, never more than 30), and shows "Rate limited, retrying" in **Voice Monkey status**. A used up monthly quota is reported but not retried.

## Troubleshooting

### The login fails or the login page does not work
- The login page cannot open on your tablet or phone: `127.0.0.1` always means "this device". Press **Open Amazon login page** and finish the login on the PC. To log in from another device anyway, set **Login proxy address** to the PC's network IP (for example `192.168.0.72`), allow Node.js through the Windows Firewall, and open `http://<that IP>:3456/` on the other device.
- Open the login URL **on the PC running Touch Portal**, with the exact address shown (for example `http://127.0.0.1:3456/`). The address you type must match **Login proxy address** in the settings, or Amazon shows a page saying alexa.amazon is deprecated with a QR code.
- Do not use a phone or tablet that has the Alexa app installed.
- If you see "address already in use" in the log, change **Login proxy port** (for example to `3457`) and save.
- If you still use e-mail or SMS based two-step verification, switch to an authenticator app in your Amazon account settings. The library notes the older methods might not work.
- If the status says the login was rejected, run **Sign in to Amazon again**.
- Check that **Amazon region** matches your account. Changing the region always needs a new login.

### No devices found
- Wait until **Alexa connection** shows `Connected`, then run **Refresh lists from Amazon**.
- Check **Number of Echo devices found** and the log (`logs/plugin.log`). Look for lines starting with "Found".
- Make sure the region is right. An account registered on amazon.co.uk will not show devices with the US region.
- Phones and tablets with the Alexa app are filtered out on purpose.

### The push connection will not connect
The plugin still works without it. It polls instead, so updates are just slower.
- Amazon sometimes blocks the push endpoint for a while after many connection attempts. Wait a few hours and run **Reconnect to Amazon**.
- If it never connects, do what the alexa-remote2 maintainers recommend: close Touch Portal, delete `alexa-auth.json` **and** `alexa-former-data.json` from `%APPDATA%\AlexaControl-TouchPortal`, start Touch Portal, and log in again.

### A button does nothing
- Look at **Alexa Control last error**. Every failure is written there and to the log.
- Media control only works while the Echo has an active music session.
- Commands are queued and sent at most one per second, so a fast burst of presses arrives over a few seconds.
- If you press buttons very quickly, Amazon may answer "Rate exceeded". The library then retries that one command by itself about 10 to 60 seconds later (so it can happen late), and the plugin refuses new commands until that window is over. **Alexa status message** shows "paused for N s" and **Alexa Control last error** explains it. Wait, then press again.

### Touch Portal uses a different computer address
If you use Touch Portal's "external computer connection" settings, the plugin cannot reach Touch Portal at 127.0.0.1. Create a file named `connection.json` in the plugin folder:
```json
{ "host": "192.168.0.10", "port": 12136 }
```

## Files

The plugin folder is `%APPDATA%\TouchPortal\plugins\AlexaControl\`.

| Path | What it is |
|---|---|
| `logs/plugin.log` | The log. Capped at 1 MB, with up to 3 older files (`plugin.log.1` to `.3`). Cookies, tokens and passwords are removed before anything is written. Set **Log level** to `debug` for more detail. |
| `%APPDATA%\AlexaControl-TouchPortal\alexa-auth.json` | Your saved Amazon login. **Treat it like a password.** It is stored in plain text, readable by your Windows user. Delete it to log out. |
| `%APPDATA%\AlexaControl-TouchPortal\alexa-former-data.json` | Device registration details the login library reuses, so each new login does not add another "device" to your Amazon account. |

These two files live outside the plugin folder on purpose: Touch Portal deletes and recreates the plugin folder when you re-import the .tpp, which would otherwise log you out. Version 1.2 and older kept them in the plugin's `data` folder; newer versions move them automatically. The log in `logs/` does start over after a re-import.

## Building from source

```
npm install
npm run verify     # syntax check, lint, unit tests
npm run package    # writes dist/AlexaControl.tpp
```

`npm run package` copies the plugin into `build/AlexaControl`, installs the production dependencies there with `npm ci --omit=dev`, refuses to continue if any native (compiled) module appears, and zips the folder into `dist/AlexaControl.tpp` with `entry.tp` directly inside the root folder, as Touch Portal requires.

**Why node_modules are shipped instead of a bundled .exe:** you already have Node.js, the code stays plain readable JavaScript that you can open and edit in the installed plugin folder, and there is no native code, so files built on any OS work on Windows. The downside is that the plugin depends on Node.js being on your PATH.

## Project layout

```
entry.tp              Touch Portal description file (actions, states, settings)
src/index.js          Startup, wiring, graceful shutdown
src/tp-client.js      Touch Portal socket client (pairing, line protocol)
src/tp.js             Sends states, lists and slider updates (only on change)
src/actions.js        Routes actions and slider moves to the backends
src/alexa/backend.js  Alexa login, discovery, commands, push and polling
src/alexa/parse.js    Turns Amazon responses into simple lists
src/alexa/auth-store.js  Saved login file
src/voicemonkey.js    Voice Monkey client with 429 backoff
src/queue.js          Rate limited call queue with timeouts
src/logger.js, src/redact.js   Log file with rotation and secret removal
src/open-url.js       Opens the login page in the PC's browser
src/settings.js, src/regions.js, src/ids.js
scripts/package.js    Builds the .tpp
test/                 Tests with a mocked alexa-remote2 and a mocked Touch Portal
```

## Credits

- [alexa-remote2](https://github.com/Apollon77/alexa-remote) by Apollon77 and contributors (MIT).
- Touch Portal API documentation: touch-portal.com/api.
- Voice Monkey API v3 documentation: voicemonkey.io/docs.
