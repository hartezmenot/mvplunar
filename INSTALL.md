# Install MVP Lunar

## Windows

Download and run the `MVP Lunar Setup <version>.exe` installer. It installs for the current Windows user and can create Start menu and desktop shortcuts.

To build it yourself on Windows, install Node.js, open PowerShell in the project folder, and run:

```powershell
npm ci
npm run build:win
```

Find the installer in `dist/`. To build a portable executable instead, use `npm run build:win:portable`.

Windows supports the desktop app, soundboard, keyboard shortcuts, saved settings, and LAN control. Live app mixing, routing, audio meters, and microphone effects are Linux PipeWire features and are not available on Windows yet.

## Linux

The Linux audio mixer requires PipeWire, `pipewire-pulse`, and WirePlumber. RNNoise noise suppression is optional and needs an RNNoise LV2 plugin such as `noise-suppression-for-voice`.

### AppImage

```bash
chmod +x "MVP Lunar-1.0.1.AppImage"
./"MVP Lunar-1.0.1.AppImage"
```

### Debian / Ubuntu

```bash
sudo apt install ./mvp-lunar_1.0.1_amd64.deb
```

## LAN control

Enable LAN in Settings, then open this address on your phone, tablet, or another computer on the same network:

```text
http://<YOUR_LOCAL_IP>:1130
```

Support the project: <https://ko-fi.com/hartezmenot>
