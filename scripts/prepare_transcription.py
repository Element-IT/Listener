import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

from transcription_runtime import probe_runtime

TORCH_VERSION = "2.11.0"
WORKER = Path(__file__).with_name("gigaam_worker.py")
REQUIREMENTS = Path(__file__).resolve().parents[1] / "requirements.txt"


def emit(stage, **values):
    print(json.dumps({"stage": stage, **values}, ensure_ascii=False), flush=True)


def version_tuple(value):
    return tuple(int(part) for part in re.findall(r"\d+", value)[:3])


def choose_variant(runtime, device, system=None):
    system = system or platform.system()
    if device == "cpu" or not runtime.get("gpus"):
        return "cpu"
    minimum = (570, 65) if system == "Windows" else (570, 26)
    if system in ("Windows", "Linux") and any(
        version_tuple(gpu.get("driverVersion", "")) >= minimum for gpu in runtime["gpus"]
    ):
        return "cu128"
    return "cpu"


def usable(runtime, device, variant=None):
    if not runtime.get("available"):
        return False
    selected = runtime.get("selectedDevice") or ""
    return selected.startswith("cuda") if device.startswith("cuda") or variant == "cu128" else bool(selected)


def probe_python(python, device):
    try:
        result = subprocess.run(
            [str(python), str(WORKER), "--check-runtime", "--device", device],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        if result.returncode != 0:
            return {"available": False, "error": result.stderr[-1500:] or f"Runtime probe exited with code {result.returncode}."}
        for line in reversed(result.stdout.splitlines()):
            try:
                parsed = json.loads(line)
                if isinstance(parsed, dict) and "available" in parsed:
                    return parsed
            except ValueError:
                pass
        return {"available": False, "error": result.stderr[-1500:] or "Invalid runtime probe response."}
    except (OSError, subprocess.SubprocessError) as error:
        return {"available": False, "error": str(error)}


@contextmanager
def installation_lock(root):
    with (root / ".setup.lock").open("a+b") as handle:
        handle.seek(0)
        handle.write(b"0")
        handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def install_step(command, env, log_path):
    with log_path.open("a", encoding="utf-8") as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, env=env,
                                timeout=1800, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    if result.returncode:
        raise RuntimeError(f"Package installation failed (exit {result.returncode}). See {log_path}.")


def prepare(args):
    emit("checking")
    base = probe_runtime(args.device)
    variant = choose_variant(base, args.device)
    emit("checking", runtime=base, variant=variant)
    if usable(base, args.device, variant) or not re.fullmatch(r"auto|cpu|cuda(?::\d+)?", args.device):
        return {"pythonPath": sys.executable, "runtime": base, "source": "configured"}

    root = Path(args.runtime_dir).resolve()
    target = root / f"gigaam-py{sys.version_info.major}{sys.version_info.minor}-{TORCH_VERSION}-{variant}"
    python = target / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if python.is_file():
        emit("verifying", variant=variant)
        cached = probe_python(python, args.device)
        if usable(cached, args.device, variant):
            return {"pythonPath": str(python), "runtime": cached, "source": "managed"}

    try:
        if not args.auto_install:
            raise RuntimeError("Automatic runtime installation is disabled (GIGAAM_AUTO_INSTALL=false).")
        if args.device.startswith("cuda") and variant == "cpu":
            raise RuntimeError("CUDA installation requires a supported NVIDIA driver (Windows >=570.65, Linux >=570.26).")
        root.mkdir(parents=True, exist_ok=True)
        with installation_lock(root):
            required = (12 if variant == "cu128" else 3) * 1024 ** 3
            if shutil.disk_usage(root).free < required:
                raise RuntimeError(f"Not enough disk space: runtime setup needs {required // 1024 ** 3} GB free. Set GIGAAM_RUNTIME_DIR to another drive.")
            temp = root / "tmp"
            temp.mkdir(exist_ok=True)
            env = {**os.environ, "TMP": str(temp), "TEMP": str(temp), "TMPDIR": str(temp),
                   "PYTHONIOENCODING": "utf-8", "PIP_DISABLE_PIP_VERSION_CHECK": "1"}
            proxy = os.environ.get("GIGAAM_PIP_PROXY", "").strip()
            if proxy.lower() == 'direct':
                for key in ('PIP_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
                    env.pop(key, None)
                env.update(NO_PROXY='*', no_proxy='*')
            elif proxy:
                env["PIP_PROXY"] = proxy
            log_path = root / "install.log"
            emit("creating", variant=variant)
            if not python.is_file():
                install_step([sys.executable, "-m", "venv", str(target)], env, log_path)
            pip = [str(python), "-m", "pip", "--disable-pip-version-check", "--no-input", "install", "--no-cache-dir", "--timeout", "60", "--retries", "3"]
            emit("installing_torch", variant=variant)
            install_step([*pip, "--only-binary=:all:", f"torch=={TORCH_VERSION}+{variant}",
                          f"torchaudio=={TORCH_VERSION}+{variant}", "--index-url",
                          f"https://download.pytorch.org/whl/{variant}"], env, log_path)
            emit("installing_gigaam", variant=variant)
            install_step([*pip, "--index-url", "https://pypi.org/simple", "-r", str(REQUIREMENTS)], env, log_path)
            emit("verifying", variant=variant)
            installed = probe_python(python, args.device)
            if not usable(installed, args.device, variant):
                raise RuntimeError(installed.get("error") or "Installed runtime did not pass the CUDA computation check.")
            return {"pythonPath": str(python), "runtime": installed, "source": "managed"}
    except (OSError, subprocess.SubprocessError, RuntimeError) as error:
        # Keep the working interpreter untouched if preparation fails.
        return {"pythonPath": sys.executable, "runtime": base, "source": "configured", "setupError": str(error)}


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--no-install", action="store_false", dest="auto_install")
    args = parser.parse_args()
    args.device = args.device.strip().lower()
    try:
        result = prepare(args)
        emit("done", **result)
        return 0
    except Exception as error:
        emit("failed", error=str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
