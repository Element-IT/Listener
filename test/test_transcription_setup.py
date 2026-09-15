import argparse
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import prepare_transcription as setup


CPU = {"available": True, "selectedDevice": "cpu", "gpus": [{"name": "RTX", "driverVersion": "610.62"}]}
GPU = {**CPU, "selectedDevice": "cuda:0"}


class SetupTests(unittest.TestCase):
    def test_selects_cuda_for_supported_nvidia_driver(self):
        self.assertEqual(setup.choose_variant(CPU, "auto", "Windows"), "cu128")
        self.assertEqual(setup.choose_variant(CPU, "auto", "Linux"), "cu128")

    def test_cpu_is_selected_without_nvidia_or_when_forced(self):
        self.assertEqual(setup.choose_variant({"gpus": []}, "auto"), "cpu")
        self.assertEqual(setup.choose_variant(CPU, "cpu"), "cpu")
        old_driver = {"gpus": [{"driverVersion": "550.50"}]}
        self.assertEqual(setup.choose_variant(old_driver, "auto", "Windows"), "cpu")

    def test_cuda_candidate_cannot_pass_verification_by_falling_back_to_cpu(self):
        self.assertFalse(setup.usable(CPU, "auto", "cu128"))
        self.assertFalse(setup.usable(CPU, "cuda"))
        self.assertTrue(setup.usable(GPU, "auto", "cu128"))

    def test_crashed_probe_cannot_activate_an_environment_even_if_it_printed_json(self):
        completed = SimpleNamespace(returncode=1, stdout='{"available": true, "selectedDevice": "cuda:0"}', stderr='Probe crashed')
        with patch.object(setup.subprocess, "run", return_value=completed):
            result = setup.probe_python("unused-python", "auto")
        self.assertFalse(result["available"])
        self.assertEqual(result["error"], "Probe crashed")

    def test_working_configured_gpu_is_not_reinstalled(self):
        args = argparse.Namespace(device="auto", auto_install=True, runtime_dir="unused")
        with patch.object(setup, "probe_runtime", return_value=GPU), \
             patch.object(setup, "emit"), patch.object(setup, "install_step") as install:
            result = setup.prepare(args)
        self.assertEqual(result["source"], "configured")
        install.assert_not_called()

    def test_cached_managed_gpu_is_reused_even_if_auto_install_is_disabled(self):
        args = argparse.Namespace(device="auto", auto_install=False, runtime_dir="unused")
        with patch.object(setup, "probe_runtime", return_value=CPU), patch.object(setup, "emit"), \
             patch.object(Path, "is_file", return_value=True), \
             patch.object(setup, "probe_python", return_value=GPU), \
             patch.object(setup, "install_step") as install:
            result = setup.prepare(args)
        self.assertEqual(result["source"], "managed")
        self.assertEqual(result["runtime"]["selectedDevice"], "cuda:0")
        install.assert_not_called()

    def test_installation_is_isolated_and_pins_matching_torch_audio_builds(self):
        with tempfile.TemporaryDirectory() as root, \
             patch.object(setup, "probe_runtime", return_value=CPU), patch.object(setup, "emit"), \
             patch.object(setup.shutil, "disk_usage", return_value=SimpleNamespace(free=30 * 1024 ** 3)), \
             patch.object(setup, "install_step") as install, \
             patch.object(setup, "probe_python", return_value=GPU):
            result = setup.prepare(argparse.Namespace(device="auto", auto_install=True, runtime_dir=root))
            self.assertEqual(result["source"], "managed")
            calls = [call.args[0] for call in install.call_args_list]
            self.assertEqual(calls[0][:3], [sys.executable, "-m", "venv"])
            self.assertIn("torch==2.11.0+cu128", calls[1])
            self.assertIn("torchaudio==2.11.0+cu128", calls[1])
            self.assertIn("https://download.pytorch.org/whl/cu128", calls[1])
            self.assertNotEqual(calls[1][0], sys.executable)
            self.assertTrue(result["pythonPath"].startswith(str(Path(root).resolve())))

    def test_failed_installation_preserves_working_cpu(self):
        with tempfile.TemporaryDirectory() as root, \
             patch.object(setup, "probe_runtime", return_value=CPU), patch.object(setup, "emit"), \
             patch.object(setup.shutil, "disk_usage", return_value=SimpleNamespace(free=30 * 1024 ** 3)), \
             patch.object(setup, "install_step", side_effect=RuntimeError("Download failed")):
            result = setup.prepare(argparse.Namespace(device="auto", auto_install=True, runtime_dir=root))
        self.assertEqual(result["runtime"], CPU)
        self.assertEqual(result["pythonPath"], sys.executable)
        self.assertEqual(result["setupError"], "Download failed")

    def test_direct_download_mode_overrides_proxies_only_in_the_installer_environment(self):
        with tempfile.TemporaryDirectory() as root, \
             patch.object(setup, "probe_runtime", return_value=CPU), patch.object(setup, "emit"), \
             patch.object(setup.shutil, "disk_usage", return_value=SimpleNamespace(free=30 * 1024 ** 3)), \
             patch.dict(setup.os.environ, {"GIGAAM_PIP_PROXY": "direct", "HTTPS_PROXY": "http://example.invalid:8080"}), \
             patch.object(setup, "install_step") as install, patch.object(setup, "probe_python", return_value=GPU):
            setup.prepare(argparse.Namespace(device="auto", auto_install=True, runtime_dir=root))
            environment = install.call_args.args[1]
            self.assertEqual(environment["NO_PROXY"], "*")
            self.assertNotIn("HTTPS_PROXY", environment)
            self.assertEqual(setup.os.environ["HTTPS_PROXY"], "http://example.invalid:8080")

    def test_failed_post_install_cuda_check_does_not_activate_the_managed_environment(self):
        with tempfile.TemporaryDirectory() as root, \
             patch.object(setup, "probe_runtime", return_value=CPU), patch.object(setup, "emit"), \
             patch.object(setup.shutil, "disk_usage", return_value=SimpleNamespace(free=30 * 1024 ** 3)), \
             patch.object(setup, "install_step"), patch.object(setup, "probe_python", return_value=CPU):
            result = setup.prepare(argparse.Namespace(device="auto", auto_install=True, runtime_dir=root))
        self.assertEqual(result["source"], "configured")
        self.assertIn("CUDA computation check", result["setupError"])

    def test_os_lock_prevents_concurrent_installations(self):
        with tempfile.TemporaryDirectory() as root:
            with setup.installation_lock(Path(root)):
                with self.assertRaises(OSError):
                    with setup.installation_lock(Path(root)):
                        self.fail("The second installer must not acquire the lock")
            with setup.installation_lock(Path(root)):
                pass

    def test_low_disk_space_stops_before_installing_any_package(self):
        with tempfile.TemporaryDirectory() as root, \
             patch.object(setup, "probe_runtime", return_value=CPU), patch.object(setup, "emit"), \
             patch.object(setup.shutil, "disk_usage", return_value=SimpleNamespace(free=1)), \
             patch.object(setup, "install_step") as install:
            result = setup.prepare(argparse.Namespace(device="auto", auto_install=True, runtime_dir=root))
        self.assertIn("Not enough disk space", result["setupError"])
        install.assert_not_called()

    def test_explicit_unavailable_cuda_is_not_reported_as_successful_cpu_fallback(self):
        unavailable = {"available": False, "selectedDevice": None, "gpus": [], "error": "CUDA unavailable"}
        with tempfile.TemporaryDirectory() as root, \
             patch.object(setup, "probe_runtime", return_value=unavailable), patch.object(setup, "emit"), \
             patch.object(setup, "install_step") as install:
            result = setup.prepare(argparse.Namespace(device="cuda", auto_install=True, runtime_dir=root))
        self.assertFalse(result["runtime"]["available"])
        self.assertTrue(result["setupError"])
        install.assert_not_called()


if __name__ == "__main__":
    unittest.main()
