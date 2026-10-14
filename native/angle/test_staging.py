"""Tests for what build_angle.py stages next to the libraries.

  python3 -m unittest discover -s native/angle -p "test_*.py"
"""

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import build_angle  # noqa: E402


class StageHeadersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_stages_headers_without_dotfiles_so_the_manifest_matches_the_uploaded_artifact(self):
        # actions/upload-artifact drops hidden files; a staged one would be listed but never shipped.
        work, stage = self.tmp / "angle", self.tmp / "stage"
        (work / "include/EGL/sub").mkdir(parents=True)
        (work / "include/EGL/egl.h").write_text("/* egl */\n")
        (work / "include/EGL/sub/extra.h").write_text("/* extra */\n")
        (work / "include/EGL/.clang-format").write_text("DisableFormat: true\n")
        (work / "include/EGL/.hidden").mkdir()
        (work / "include/EGL/.hidden/inner.h").write_text("/* hidden */\n")
        stage.mkdir()
        build_angle.stage_headers({"headers": ["include/EGL"]}, work, stage)
        staged = sorted(path.relative_to(stage).as_posix() for path in stage.rglob("*") if path.is_file())
        self.assertEqual(staged, ["include/EGL/egl.h", "include/EGL/sub/extra.h"])


if __name__ == "__main__":
    unittest.main()
