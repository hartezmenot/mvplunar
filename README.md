# MVP Lunar

MVP Lunar is an audio control suite inspired by SteelSeries GG Sonar and VoiceMeeter. The current project supports Linux audio routing through PipeWire and provides a Windows desktop build for its soundboard and control interface.

## Features

- Per app mixing, device routing, audio meters, stream mixes, and microphone processing on Linux with PipeWire and `pipewire-pulse`.
- Local soundboard with custom clips, categories, per clip volume, output selection, and keyboard shortcuts.
- Remote control from a phone, tablet, or another computer over your local network.
- Saved settings and soundboard clips.

## Platform support

### Linux

The full audio mixer requires PipeWire, `pipewire-pulse`, and WirePlumber. RNNoise noise suppression also requires an RNNoise LV2 plugin such as `noise-suppression-for-voice`.

Wayland is the primary desktop environment. X11 is available but has not been tested as extensively.

### Windows

The Windows desktop app, local soundboard playback, keyboard shortcuts, saved settings, and LAN control are available. Live application mixing and routing, PipeWire meters, virtual mixer devices, and microphone effects currently require Linux with PipeWire.

Build the installer from a Windows machine with Node.js installed:

```powershell
npm ci
npm run build:win
```

The installer is written to `dist/`. For an unpacked portable executable, run `npm run build:win:portable`.
The Windows build workflow also stores the installer as a GitHub Actions artifact for 30 days.

To run the desktop app from a checkout:

```powershell
npm ci
npm run app:windows
```

The app keeps Windows settings and soundboard clips in the per user application data folder. The packaged app does not include the checkout's local `data/` files.

## Remote control

Enable LAN in Settings, then visit the host computer's local IP and port 1130 from another device:

```text
http://<YOUR_LOCAL_IP>:1130
```

## Linux packages

Build both supported Linux packages with:

```bash
npm ci
npm run build:linux
```

On most Linux systems, the AppImage can be launched directly. The Debian package installs a desktop entry.

## Support

MVP Lunar is free and open source under the MIT license. Feedback and bug reports are welcome.

Support the project: <https://ko-fi.com/hartezmenot>
