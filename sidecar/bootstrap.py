# sidecar/bootstrap.py
import argparse
import os
import uvicorn

def main():
  p = argparse.ArgumentParser()
  p.add_argument("--workdir", default=os.path.expanduser("~/lr_sidecar"))
  p.add_argument("--port", default="8765")
  args = p.parse_args()

  os.makedirs(args.workdir, exist_ok=True)
  os.chdir(args.workdir)
  # single worker so the in-memory Account is shared
  uvicorn.run("sidecar.app:app", host="127.0.0.1", port=int(args.port), workers=1)

if __name__ == "__main__":
  main()
