# MVP Lunar

A high-performance audio control suite built with care, love, and perfection for the Linux community.

Inspired by SteelSeries GG Sonar and VoiceMeeter, MVP Lunar is an all-in-one mixing and routing solution designed to empower streamers, gamers, and power users on Linux.

## 🚀 Key Features

- Advanced Mix Engine: Seamlessly control individual application volumes. Includes a dedicated Stream Mode—perfect for toggling what your audience hears versus your personal monitor mix.
- Intelligent Routing: Dynamically route active audio applications to specific outputs without touching complex system menus.
- Integrated Soundboard: Add and trigger custom sound effects instantly to enhance your content.
- Remote Control Deck: Transform your tablet, laptop, or touchscreen monitor into a physical control panel. Enable LAN settings to manage your mix wirelessly via a local web interface.

## 🐧 Linux Support

- Wayland: Fully supported and primary testing environment (best experience).
- X11 / Xorg: Currently untested. If you run an X11 session, we would love your feedback and bug reports to help reach perfection.

## ✅ Requirements

- PipeWire audio stack
- `pipewire-pulse` (PulseAudio compatibility)
- `wireplumber` session manager
- RNNoise LV2 plugin for noise suppression (optional, but required for the RNNoise toggle):
  - `noise-suppression-for-voice` (package name varies by distro)

## 🛠 Setup & Remote Access

- Enable LAN: Navigate to Settings and toggle the LAN settings to "On."
- Connect Device: Open a browser on your remote device (tablet/laptop).
- Enter Address: Type your host PC's local IP followed by the dedicated port:

```
http://<YOUR_LOCAL_IP>:1130
```

## 🧡 Support the Project

MVP Lunar is—and will always remain—free. This app is a labor of love, built to provide a professional audio experience for everyone. If you love using it and want to support its continued development:

Support the project: https://ko-fi.com/hartezmenot

Feedback is welcome! Please do not be afraid to comment or open an issue if you find anything that isn't perfect.

## ✅ Release Notes

### 1.0.1

- Cleaner UI polish across the main panels.
- PIN display streamlined (tap/hover to reveal).
- Audio status banner for pactl availability and retry timing.
- Peak meter behavior fixes and consistent dB styling.
- Stream meter now reflects linked sources.
- Routing overrides to prevent sinks snapping back.

## Desktop Entry

On most Linux systems, the AppImage will prompt to integrate into your app menu. If not, you can still run it directly.
The `.deb` package should install a desktop entry automatically.
