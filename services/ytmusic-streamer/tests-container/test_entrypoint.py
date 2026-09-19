"""Run with YTMUSIC_TEST_IMAGE set to a built sidecar image; no network or volumes."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[1] / "docker-entrypoint.sh"
PROBE = """
import os,pwd,tempfile,pathlib,sys
assert os.geteuid()==1000
assert pathlib.Path.home()==pathlib.Path(pwd.getpwuid(os.geteuid()).pw_dir)
assert os.environ['PRESERVE_THIS_VAR']=='fixture'
assert sys.argv[1:]==['argument with spaces']
with tempfile.TemporaryDirectory(prefix='startup-cache-',dir=pathlib.Path.home()) as directory:
 pathlib.Path(directory,'cache.json').write_text('{}')
print('NON_ROOT_WRITABLE_HOME_AND_ENV_OK')
"""


@pytest.mark.parametrize("start_as_root", [True, False])
def test_entrypoint_retains_non_root_home_and_environment(start_as_root: bool) -> None:
    """Actual setpriv startup must retain argv/env and allow a private home cache."""
    docker = shutil.which("docker")
    assert docker, "Docker is required for container startup verification"
    image = os.environ["YTMUSIC_TEST_IMAGE"]
    command = [docker, "run", "--rm", "-i", "--network", "none", "--entrypoint", "sh"]
    command += ["--env", "HOME=/root" if start_as_root else "HOME=/home/ytmusic"]
    command += ["--env", "PRESERVE_THIS_VAR=fixture"]
    if not start_as_root:
        command += ["--user", "1000:1000"]
    command += [image, "-s", "--", "python", "-c", PROBE, "argument with spaces"]
    result = subprocess.run(  # noqa: S603 -- operator-selected image and repo-owned startup probe
        command,
        input=ENTRYPOINT.read_text(encoding="utf-8").encode("utf-8"),
        capture_output=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, (result.stdout + result.stderr).decode("utf-8")
    assert b"NON_ROOT_WRITABLE_HOME_AND_ENV_OK" in result.stdout
