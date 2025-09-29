#!/usr/bin/env python3
import argparse, os, sys, subprocess, venv, pathlib

REQS = ["pylitterbot[http]", "fastapi", "uvicorn[standard]"]

def ensure_venv(venv_dir: str):
    py = os.path.join(venv_dir, "bin", "python")
    if not os.path.exists(py):
        venv.EnvBuilder(with_pip=True).create(venv_dir)
    try:
        subprocess.run([py, "-c", "import fastapi, uvicorn, pylitterbot"], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        subprocess.check_call([py, "-m", "pip", "install", "--disable-pip-version-check", *REQS])
    return py

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--port", default="8765")
    args = ap.parse_args()

    os.makedirs(args.workdir, exist_ok=True)
    os.chdir(args.workdir)

    # ensure local venv inside workdir (even if caller python is system python)
    venv_dir = os.path.join(args.workdir, ".venv")
    py = ensure_venv(venv_dir)

    # ensure plugin root is importable so "sidecar.app:app" resolves
    plugin_root = str(pathlib.Path(__file__).resolve().parent.parent)  # .../package-root
    os.environ["PYTHONPATH"] = f"{plugin_root}:{os.environ.get('PYTHONPATH','')}"

    # run uvicorn (single worker so Account instance is shared)
    os.execvpe(py, [py, "-m", "uvicorn", "sidecar.app:app",
                    "--host", "127.0.0.1", "--port", str(args.port), "--workers", "1"], os.environ)

if __name__ == "__main__":
    sys.exit(main())
