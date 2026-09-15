import csv
import importlib.metadata
import importlib.util
import io
import os
import re
import subprocess
from datetime import datetime, timezone


def detect_nvidia_gpus():
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,driver_version",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=5, check=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        gpus = []
        for row in csv.reader(io.StringIO(result.stdout)):
            if len(row) != 3:
                continue
            name, memory, driver = (value.strip() for value in row)
            gpus.append({
                "name": name,
                "totalMemoryBytes": int(float(memory) * 1024 * 1024) if memory.replace(".", "", 1).isdigit() else None,
                "driverVersion": driver,
            })
        return gpus
    except (OSError, subprocess.SubprocessError, ValueError):
        return []


def inspect_torch(torch, requested_device):
    requested = str(requested_device or "auto").strip().lower()
    status = {
        "torchVersion": str(torch.__version__),
        "requestedDevice": requested,
        "selectedDevice": None,
        "cuda": {"available": False, "version": torch.version.cuda, "devices": []},
        "reason": "",
    }
    cuda = status["cuda"]
    try:
        cuda["available"] = bool(torch.cuda.is_available())
        if cuda["available"]:
            for index in range(torch.cuda.device_count()):
                properties = torch.cuda.get_device_properties(index)
                cuda["devices"].append({
                    "index": index, "name": properties.name,
                    "totalMemoryBytes": properties.total_memory,
                })
            cuda["available"] = bool(cuda["devices"])
    except Exception as error:
        cuda["available"] = False
        cuda["error"] = str(error)

    if requested == "cpu":
        status.update(selectedDevice="cpu", reason="cpu_requested")
        return status
    if requested != "auto" and not re.fullmatch(r"cuda(?::\d+)?", requested):
        status["error"] = "Invalid GIGAAM_DEVICE. Use auto, cpu, cuda or cuda:N."
        return status

    if cuda["available"]:
        index = int(requested.split(":", 1)[1]) if ":" in requested else torch.cuda.current_device()
        if index >= len(cuda["devices"]):
            status["error"] = f"Requested CUDA device {index} is not visible to PyTorch."
            return status
        device = f"cuda:{index}"
        try:
            # Exercise a kernel too: a visible GPU can still be incompatible with this torch build.
            torch.ones(1, device=device).add_(1).item()
            torch.cuda.synchronize(index)
            status.update(selectedDevice=device, reason="cuda_ready")
            return status
        except Exception as error:
            cuda["available"] = False
            cuda["error"] = str(error)

    status["reason"] = "cuda_check_failed" if cuda.get("error") else (
        "torch_cpu_only" if not cuda["version"] else "cuda_unavailable"
    )
    if requested == "auto":
        status["selectedDevice"] = "cpu"
    else:
        status["error"] = "CUDA was explicitly requested but is unavailable to PyTorch. " + cuda.get("error", "")
    return status


def probe_runtime(requested_device="auto"):
    status = {
        "available": False, "package": "gigaam", "version": "",
        "requestedDevice": requested_device, "selectedDevice": None,
        "cuda": {"available": None, "version": None, "devices": []},
        "gpus": detect_nvidia_gpus(),
        "checkedAt": datetime.now(timezone.utc).isoformat(),
    }
    try:
        import torch

        status.update(inspect_torch(torch, requested_device))
        if importlib.util.find_spec("gigaam") is None:
            raise RuntimeError("GigaAM is not installed in the configured Python environment.")
        # Import dependencies without loading weights or downloading the model.
        import gigaam  # noqa: F401

        status["version"] = importlib.metadata.version("gigaam")
        status["available"] = bool(status["selectedDevice"] and not status.get("error"))
    except Exception as error:
        status["error"] = str(error)
    if not status["gpus"]:
        status["gpus"] = status["cuda"]["devices"]
    return status
