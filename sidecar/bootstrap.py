import argparse, os, subprocess, sys

def run(cmd, **kw):
    return subprocess.check_call(cmd, **kw)

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--workdir", required=True)
    p.add_argument("--port", required=True)
    args = p.parse_args()

    wd = args.workdir
    os.makedirs(wd, exist_ok=True)
    venv = os.path.join(wd, ".venv")
    py = sys.executable

    if not (os.path.exists(os.path.join(venv, "bin")) or os.path.exists(os.path.join(venv, "Scripts"))):
        run([py, "-m", "venv", venv])

    pip = os.path.join(venv, "bin", "pip") if os.name != "nt" else os.path.join(venv, "Scripts", "pip.exe")
    uvicorn = os.path.join(venv, "bin", "uvicorn") if os.name != "nt" else os.path.join(venv, "Scripts", "uvicorn.exe")
    req = os.path.join(os.path.dirname(__file__), "requirements.txt")

    run([pip, "install", "-q", "-r", req])

    app_dir = os.path.dirname(__file__)
    os.execv(uvicorn, [uvicorn, "app:app", "--host", "127.0.0.1", "--port", args.port, "--app-dir", app_dir])

if __name__ == "__main__":
    main()
