from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from pylitterbot import Account
from typing import Optional, Dict

app = FastAPI()
account: Optional[Account] = None

STATUS_LABELS: Dict[str, str] = {
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
    "p": "Paused",
    "pd": "Pinch Detect",
    "pwrd": "Powering Down",
    "pwru": "Powering Up",
    "rdy": "Ready",
    "scf": "Cat Sensor Fault At Startup",
    "sdf": "Drawer Full At Startup",
    "spf": "Pinch Detect At Startup",
}

class Login(BaseModel):
    username: str
    password: str

@app.post("/login")
async def login(body: Login):
    global account
    try:
        account = await Account().connect(body.username, body.password)
        await account.refresh_robots()
        return {"ok": True, "robots": [r.id for r in account.robots]}
    except Exception as e:
        raise HTTPException(401, str(e))

def find_robot(robot_id: str):
    if account is None:
        raise HTTPException(401, "Not logged in")
    for r in account.robots:
        if r.id == robot_id:
            return r
    raise HTTPException(404, "Robot not found")

@app.get("/status/{robot_id}")
async def status(robot_id: str):
    robot = find_robot(robot_id)
    await robot.refresh()

    code_raw = getattr(robot, "status_code", None)
    code = (code_raw.lower() if isinstance(code_raw, str) else None)
    label = STATUS_LABELS.get(code) if code else None

    return {
        "id": robot.id,
        "name": robot.name,
        "status_code": code,
        "status_label": label,
        "cycle": robot.is_cycling,
        "idle": robot.is_ready,
        "pinch": robot.is_pinch_detected,
        "bonnet": robot.is_panel_removed,
        "home": robot.is_at_home_position,
        "paused": robot.is_paused,
        "offline": (not robot.is_online),
    }

@app.post("/cycle/{robot_id}")
async def start_cycle(robot_id: str):
    robot = find_robot(robot_id)
    await robot.start_cleaning()
    return {"ok": True}
