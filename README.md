# homebridge-litterrobot-pylb

**Litter-Robot Homebridge plugin with a Python sidecar: clean cycle control plus completed and fault/interrupt signals.**

This plugin exposes a simple, reliable HomeKit surface while delegating all Litter-Robot API work to a tiny **FastAPI + `pylitterbot`** sidecar running locally.

- **Controls**
  - **Cycle Now** (Control Switch)

- **Sensors**
  - **Cycle Completed** (Motion, pulses briefly for automations/notifications)
  - **Cycle Fault** (Contact, OPEN on fault/interrupt)
  - **Bonnet** (Contact)
  - **Pinch** (Contact)
  - **Offline** (Occupancy)

- **Debug Heartbeat** (single log line per poll)
  - Includes **raw status code** and **label**, e.g. `ccc (Clean Cycle Complete)`, plus key booleans.


### Sidecar (FastAPI + pylitterbot)
This plugin talks to a Python sidecar over HTTP. Point `sidecarUrl` at wherever it’s running:
- Local HB host: `http://127.0.0.1:8765`
- Another box/container: `http://host-or-ip:8765`

If the sidecar is down, the plugin will idle and log a single backoff message per retry window; it won’t crash or spam.


---

## Install (from your Git branch)

> This repo follows the official Homebridge **dynamic plugin template** (ESM). It **builds on install** via `prepare`.

1. In the Homebridge UI, open **Terminal** (or use “Install from GitHub”).
2. Install from your branch:
   ```bash
   npm i git+https://github.com/vivellimac/homebridge-litterrobot-pylb.git
3. Restart Homebridge if the UI doesn’t prompt you.
  - If you use a private repo, make sure Homebridge has access to it.
