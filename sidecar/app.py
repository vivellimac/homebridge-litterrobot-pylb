# sidecar/app.py
import os
import asyncio
from typing import Dict, Optional
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from pylitterbot import Account  # GOLD STANDARD

HA_STATUS_LABELS: Dict[str, str] = {
    "br": "Bonnet Removed",
    "ccc": "Clean Cycle Complete",
    "ccp": "Clean Cycle In Progress",
    "cd": "Cat Detected",
    "csf": "Cat Sensor Fault",
    "csi": "Cat Sensor Interrupted",
    "cst": "Cat Sensor Timing",
    "df1": "Drawer Almost Full - 2 Cycles Left",
    "df2": "Drawer Almost Full - 1 Cycle Left",
    "dfs": "Drawer Full",
    "dhf": "Dump + Home Position Fault",
    "dpf": "Dump Position Fault",
    "ec": "Empty Cycle",
    "hpf": "Home Position Fault",
    "off": "Off",
    "offline": "Offline",
    "otf": "Over Torque Fault",
    "pd": "Pinch Detect",
    "scf": "Sifting Cycle Fault",
    "sdf": "Sensor Fault",
    "spf": "Scraper Position Fault",
    "rdy": "Ready",
}

def derive_flags(code: Optional[str]):
    code = (code or "").lower()
    return {
        "cycle": code in {"ccp", "ec"},
        "idle": code in {"rdy", "off"},
        "pinch": code == "pd",
        "bonnet": code == "br",
        "home": code in {"rdy", "ccc", "dfs", "off"},
        "paused": code in {"csi", "cst"},
        "offline": code == "offline",
    }

class LoginRequest(BaseModel):
    username: str
    password: str

app = FastAPI(title="Litter-Robot Sidecar", version="0.2.0")

@app.on_event("startup")
async def on_startup():
    app.state.account = None
    app.state.lock = asyncio.Lock()

@app.on_event("shutdown")
async def on_shutdown():
    acc: Optional[Account] = getattr(app.state, "account", None)
    if acc:
        try:
            await acc.disconnect()
        except Exception:
            pass

@app.get("/health")
async def health():
    return {"ok": True}

@app.post("/login")
async def login(body: LoginRequest):
    async with app.state.lock:
        if getattr(app.state, "account", None):
            return {"robots": [r.serial for r in app.state.account.robots]}

        acc = Account()
        await acc.connect(username=body.username, password=body.password, load_robots=True)
        app.state.account = acc
        return {"robots": [r.serial for r in acc.robots]}

async def _get_robot(serial: str):
    acc: Optional[Account] = getattr(app.state, "account", None)
    if not acc:
        raise HTTPException(status_code=401, detail="Not logged in")
    await acc.refresh_robots()
    for r in acc.robots:
        if r.serial == serial:
            return r
    raise HTTPException(status_code=404, detail="Robot not found")

@app.get("/status/{serial}")
async def status(serial: str):
    r = await _get_robot(serial)
    code = getattr(r, "status", None) or getattr(r, "status_code", None)
    if code:
        code = str(code).lower()
    flags = derive_flags(code)
    return {
        "id": r.serial,
        "name": getattr(r, "name", r.serial),
        "status_code": code,
        "status_label": HA_STATUS_LABELS.get(code) if code else None,
        **flags,
    }

@app.post("/cycle/{serial}")
async def cycle(serial: str):
    r = await _get_robot(serial)
    await r.start_cleaning()  # matches pylitterbot usage
    return {"ok": True}
