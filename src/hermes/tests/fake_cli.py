"""A stand-in for ``dist/cli.js`` that answers ``list``, ``run`` and ``target`` from a fixture.

``FAKE_CLI_FIXTURE`` names a JSON file ``{"log": <path>, "replies": {<key>: <reply>}}``. The key
is ``list``, ``run <tool-id>`` or ``target <tool-id>``; a reply is
``{"stdout": str, "stderr": str, "code": int, "sleep": seconds}``, every field optional. Each
call appends ``{"argv": [...], "stdin": str}`` to the log.

A reply with ``pid_dir`` also starts a long-lived child (as the real command line starts a subprocess)
and writes its own pid and the child's to ``<pid_dir>/fake`` and ``<pid_dir>/child``. With
``ignore_sigterm`` both ignore ``SIGTERM``.
"""

import json
import os
import signal
import subprocess
import sys
import time

CHILD_LIFETIME_SECONDS = 60

with open(os.environ["FAKE_CLI_FIXTURE"], encoding="utf-8") as fixture_file:
    fixture = json.load(fixture_file)
argv = sys.argv[1:]
stdin = sys.stdin.read()

with open(fixture["log"], "a", encoding="utf-8") as log:
    log.write(json.dumps({"argv": argv, "stdin": stdin}) + "\n")

key = " ".join(argv[:2]) if argv and argv[0] != "list" else "list"
reply = fixture["replies"].get(key, {"stderr": f"fake-cli: no reply for {key!r}", "code": 2})

if "pid_dir" in reply:
    ignore = "signal.signal(signal.SIGTERM, signal.SIG_IGN); " if reply.get("ignore_sigterm") else ""
    child = subprocess.Popen(
        [sys.executable, "-c", f"import signal, time; {ignore}time.sleep({CHILD_LIFETIME_SECONDS})"]
    )
    if reply.get("ignore_sigterm"):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    for name, pid in (("fake", os.getpid()), ("child", child.pid)):
        with open(os.path.join(reply["pid_dir"], name), "w", encoding="utf-8") as pid_file:
            pid_file.write(str(pid))

time.sleep(reply.get("sleep", 0))
sys.stdout.write(reply.get("stdout", ""))
sys.stderr.write(reply.get("stderr", ""))
sys.exit(reply.get("code", 0))
