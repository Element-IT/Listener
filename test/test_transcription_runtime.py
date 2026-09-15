import io
import sys
import unittest
from importlib.machinery import ModuleSpec
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import gigaam_worker
import transcription_runtime as runtime


def fake_torch(cuda_available=True, cuda_version="12.8", count=1):
    return SimpleNamespace(
        __version__="test-torch", version=SimpleNamespace(cuda=cuda_version),
        cuda=SimpleNamespace(
            is_available=Mock(return_value=cuda_available),
            device_count=Mock(return_value=count),
            current_device=Mock(return_value=0),
            get_device_properties=Mock(return_value=SimpleNamespace(name="Test GPU", total_memory=8 * 1024 ** 3)),
            synchronize=Mock(),
        ),
        ones=Mock(),
    )


class RuntimeTests(unittest.TestCase):
    def test_auto_uses_cpu_with_cpu_only_pytorch(self):
        torch = fake_torch(False, None)
        result = runtime.inspect_torch(torch, "auto")
        self.assertEqual(result["selectedDevice"], "cpu")
        self.assertEqual(result["reason"], "torch_cpu_only")
        torch.ones.assert_not_called()

    def test_auto_uses_cuda_only_after_exercising_a_kernel(self):
        torch = fake_torch()
        result = runtime.inspect_torch(torch, "auto")
        self.assertEqual(result["selectedDevice"], "cuda:0")
        self.assertTrue(result["cuda"]["available"])
        self.assertEqual(result["cuda"]["devices"][0]["name"], "Test GPU")
        torch.ones.assert_called_once_with(1, device="cuda:0")
        torch.cuda.synchronize.assert_called_once_with(0)

    def test_explicit_cpu_does_not_allocate_gpu_memory(self):
        torch = fake_torch()
        result = runtime.inspect_torch(torch, "cpu")
        self.assertTrue(result["cuda"]["available"])
        self.assertEqual(result["selectedDevice"], "cpu")
        self.assertEqual(result["reason"], "cpu_requested")
        torch.ones.assert_not_called()

    def test_explicit_cuda_device_selects_the_requested_visible_index(self):
        torch = fake_torch(count=2)
        result = runtime.inspect_torch(torch, "cuda:1")
        self.assertEqual(result["selectedDevice"], "cuda:1")
        torch.ones.assert_called_once_with(1, device="cuda:1")

    def test_missing_or_invalid_explicit_cuda_never_falls_back_silently(self):
        for torch, device in [(fake_torch(False, None), "cuda"), (fake_torch(), "cuda:5"), (fake_torch(), "broken")]:
            result = runtime.inspect_torch(torch, device)
            self.assertIsNone(result["selectedDevice"])
            self.assertTrue(result["error"])

    def test_cuda_kernel_failure_falls_back_only_in_auto_mode(self):
        for device in ["auto", "cuda"]:
            torch = fake_torch()
            torch.ones.side_effect = RuntimeError("no kernel image")
            result = runtime.inspect_torch(torch, device)
            self.assertFalse(result["cuda"]["available"])
            self.assertEqual(result["reason"], "cuda_check_failed")
            self.assertEqual(result["cuda"]["error"], "no kernel image")
            self.assertEqual(result["selectedDevice"], "cpu" if device == "auto" else None)

    def test_cuda_driver_failure_keeps_cpu_usable(self):
        torch = fake_torch()
        torch.cuda.is_available.side_effect = RuntimeError("driver missing")
        result = runtime.inspect_torch(torch, "auto")
        self.assertEqual(result["selectedDevice"], "cpu")
        self.assertEqual(result["cuda"]["error"], "driver missing")

    def test_cuda_build_without_visible_gpu_uses_cpu(self):
        result = runtime.inspect_torch(fake_torch(False), "auto")
        self.assertEqual(result["selectedDevice"], "cpu")
        self.assertEqual(result["reason"], "cuda_unavailable")

    def test_nvidia_detection_reads_csv_without_claiming_cuda_is_usable(self):
        output = SimpleNamespace(stdout='"GPU, model", 8192, 610.62\nOther GPU, [N/A], 610.62\n')
        with patch.object(runtime.subprocess, "run", return_value=output):
            gpus = runtime.detect_nvidia_gpus()
        self.assertEqual(gpus[0]["name"], "GPU, model")
        self.assertEqual(gpus[0]["totalMemoryBytes"], 8589934592)
        self.assertIsNone(gpus[1]["totalMemoryBytes"])

    def test_missing_nvidia_smi_is_not_a_transcription_error(self):
        with patch.object(runtime.subprocess, "run", side_effect=FileNotFoundError()):
            self.assertEqual(runtime.detect_nvidia_gpus(), [])

    def test_probe_detects_hardware_even_with_cpu_only_torch_and_does_not_load_weights(self):
        gigaam = SimpleNamespace(__spec__=ModuleSpec("gigaam", None), load_model=Mock())
        gpu = {"name": "Detected GPU"}
        with patch.dict(sys.modules, {"torch": fake_torch(False, None), "gigaam": gigaam}), \
             patch.object(runtime, "detect_nvidia_gpus", return_value=[gpu]), \
             patch.object(runtime.importlib.metadata, "version", return_value="0.2.0"):
            result = runtime.probe_runtime()
        self.assertTrue(result["available"])
        self.assertEqual(result["selectedDevice"], "cpu")
        self.assertEqual(result["gpus"], [gpu])
        gigaam.load_model.assert_not_called()

    def test_missing_torch_preserves_detected_hardware_and_reports_an_error(self):
        with patch.dict(sys.modules, {"torch": None}), \
             patch.object(runtime, "detect_nvidia_gpus", return_value=[{"name": "GPU"}]):
            result = runtime.probe_runtime()
        self.assertFalse(result["available"])
        self.assertEqual(result["gpus"][0]["name"], "GPU")
        self.assertTrue(result["error"])

    def test_worker_reports_actual_model_device_instead_of_auto(self):
        status = {"available": True, "selectedDevice": "cuda:1"}
        model = SimpleNamespace(parameters=lambda: iter([SimpleNamespace(device="cuda:1")]))
        with patch.object(sys, "argv", ["gigaam_worker.py", "--device", "auto"]), \
             patch.object(sys, "stdin", io.StringIO("")), \
             patch.object(gigaam_worker, "probe_runtime", return_value=status), \
             patch.object(gigaam_worker, "load_gigaam_model", return_value=model) as load, \
             patch.object(gigaam_worker, "write_json") as output:
            self.assertEqual(gigaam_worker.main(), 0)
        self.assertEqual(load.call_args.args[1], "cuda:1")
        ready = output.call_args.args[0]
        self.assertEqual(ready["device"], "cuda:1")
        self.assertEqual(ready["runtime"]["actualDevice"], "cuda:1")

    def test_check_runtime_mode_never_loads_the_model(self):
        with patch.object(sys, "argv", ["gigaam_worker.py", "--check-runtime"]), \
             patch.object(gigaam_worker, "probe_runtime", return_value={"available": True}), \
             patch.object(gigaam_worker, "load_gigaam_model") as load, \
             patch.object(gigaam_worker, "write_json"):
            self.assertEqual(gigaam_worker.main(), 0)
        load.assert_not_called()


if __name__ == "__main__":
    unittest.main()
