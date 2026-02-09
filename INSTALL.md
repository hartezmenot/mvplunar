# Install Guide

This project ships as both an AppImage and a Debian package.

## Requirements

- PipeWire audio stack
- `pipewire-pulse` (PulseAudio compatibility)
- `wireplumber` session manager
- RNNoise LV2 plugin for noise suppression (optional, but required for the RNNoise toggle):
  - `noise-suppression-for-voice` (package name varies by distro)

## AppImage (CachyOS / Arch-based)

```
chmod +x "MVP Lunar-1.0.1.AppImage"
./MVP\ Lunar-1.0.1.AppImage
```

## Debian / Ubuntu

```
sudo apt install ./mvp-lunar_1.0.1_amd64.deb
```

## Remote Control (LAN)

1) Enable LAN in Settings
2) On your phone/tablet/laptop, open a browser and go to:

```
http://<YOUR_LOCAL_IP>:1130
```

## Support the Project

Support the project: https://ko-fi.com/hartezmenot
