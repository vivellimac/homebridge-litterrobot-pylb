#!/usr/bin/env python3
import argparse
import os
import sys
import subprocess
import venv
import pathlib
from typing import List, Tuple

# Keep requirements lean; the [http] extra produces a warning on piwheels.
REQS: List[str] = ["pylitterbot", "fastapi", "uvicorn[standard]"]

LOG_FILE_NAME = "bootstrap.log"


def log_line(workdir: str, line: str) -> None:
    """Append a single line to the bootstrap log and stdout (for manual runs)."""
    try:
        fp = os.path.join(workdir, LOG_FILE_NAME)
        with open(fp, "a", encoding="utf-8") as f:
            f.write(line.rstrip() + "\n")
    except Exception:
        # Don't crash on logging issues
        pass
    # Also echo to stdout for convenience (harmless)
    print(line, flush=True)


def progress(workdir: str, pct: int, msg: str) -> None:
    log_line(workdir, f"{pct}% {msg}")


def ensure_venv(workdir: str, venv_dir: str) -> str:
    """Create a venv with pip if missing; return path to its python."""
    py = os.path.join(venv_dir, "bin", "python")
    if not os.path.exists(py):
        progress(workdir, 5, "creating virtualenv …")
        venv.EnvBuilder(with_pip=True).create(venv_dir)
        progress(workdir, 12, "virtualenv ready")
    return py


def have_imports(py: str, modules: List[str]) -> bool:
    code = ";".join(f"import {m}" for m in modules)
    try:
        subprocess.run([py, "-c", code], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except subprocess.CalledProcessError:
        return False


def pip_install(py: str, pkgs: List[str], workdir: str) -> None:
    env = dict(os.environ)
    env.setdefault("PIP_DISABLE_PIP_VERSION_CHECK", "1")
    env.setdefault("PYTHONWARNINGS", "ignore")

    # Install in small batches so we can show granular progress.
    total = len(pkgs)
    for idx, pkg in enumerate(pkgs, start=1):
        pct = 12 + int((idx / total) * 70)  # 12%..82% reserved for installs
        progress(workdir, max(13, min(pct, 82)), f"installing {pkg} …")
        subprocess.check_call(
            [py, "-m", "pip", "install", "--no-input", "--disable-pip-version-check", pkg],
            env=env,
        )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--port", default="8765")
    args = ap.parse_args()

    os.makedirs(args.workdir, exist_ok=True)
    os.chdir(args.workdir)

    # Start a fresh log for each bootstrap run
    try:
        open(LOG_FILE_NAME, "w", encoding="utf-8").close()
    except Exception:
        pass

    progress(args.workdir, 0, "bootstrap starting")
    venv_dir = os.path.join(args.workdir, ".venv")
    py = ensure_venv(args.workdir, venv_dir)

    # Ensure required libs; skip installs if imports already succeed
    need = []
    check_sets: List[Tuple[List[str], str]] = [
        (["fastapi"], "fastapi"),
        (["uvicorn"], "uvicorn[standard]"),
        (["pylitterbot"], "pylitterbot"),
    ]
    for mods, pkg in check_sets:
        if not have_imports(py, mods):
            need.append(pkg)

    if need:
        pip_install(py, need, args.workdir)
    else:
        progress(args.workdir, 20, "dependencies already satisfied")

    # Make plugin root importable so `sidecar.app:app` resolves
    plugin_root = str(pathlib.Path(__file__).resolve().parent.parent)
    os.environ["PYTHONPATH"] = f"{plugin_root}:{os.environ.get('PYTHONPATH','')}"
    progress(args.workdir, 85, "environment prepared")

    # Final nudge to indicate we're about to serve
    progress(args.workdir, 90, "launching uvicorn …")

    # Run uvicorn (single worker so Account instance is shared)
    # Progress 100% is logged by Node once /health is up; here we log our last step.
    progress(args.workdir, 95, f"binding 127.0.0.1:{args.port}")
    os.execvpe(
        py,
        [py, "-m", "uvicorn", "sidecar.app:app",
         "--host", "127.0.0.1", "--port", str(args.port), "--workers", "1"],
        os.environ,
    )
    # os.execvpe replaces the process; we never return.
    # If we ever did, consider that a failure.
    # (But this line is not expected to run.)
    # progress(args.workdir, 100, "uvicorn exited unexpectedly")
    # return 1


if __name__ == "__main__":
    sys.exit(main())
