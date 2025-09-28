# homebridge-litterrobot-pylb

**Litter-Robot Homebridge plugin with a Python sidecar: clean cycle control plus completed and fault/interrupt signals.**

This plugin exposes a simple, reliable HomeKit surface while delegating all Litter-Robot API work to a tiny **FastAPI + `pylitterbot`** sidecar running locally.

- **Controls**
  - **Cycle Now** (Switch)

- **Sensors**
  - **Cycle Completed** (Motion, pulses briefly for automations/notifications)
  - **Cycle Fault** (Contact, OPEN on fault/interrupt)
  - **Bonnet** (Contact)
  - **Pinch** (Contact)
  - **Offline** (Occupancy)

- **Debug Heartbeat** (single log line per poll)
  - Includes **raw status code** and **label**, e.g. `ccc (Clean Cycle Complete)`, plus key booleans.

---

## Install (from your Git branch)

> This repo follows the official Homebridge **dynamic plugin template** (ESM). It **builds on install** via `prepare`.

1. In the Homebridge UI, open **Terminal** (or use “Install from GitHub”).
2. Install from your branch:
   ```bash
   npm i git+https://github.com/<YOUR_ORG>/homebridge-litterrobot-pylb.git#<YOUR_BRANCH>
3. Restart Homebridge if the UI doesn’t prompt you.
  - If you use a private repo, make sure Homebridge has access to it.
