"""Manage only the exact NFQUEUE rules owned by Soundspan's direct egress.

Run inside the music host network namespace, never the shared VPN host.
Removal works even if Docker or the streamer is stopped.
"""

from __future__ import annotations

import ipaddress
import json
import shlex
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path

TARGET = "soundspan-prod-ytmusic"
OWNER = "soundspan-http3-egress"
QUEUE = "33363"
MARK = "0x5354/0xffffffff"
Runner = Callable[[list[str]], str]


def run(args: list[str]) -> str:
    """Run an argument vector without a shell or exposing Docker's environment."""
    # Only fixed docker/iptables commands and validated IPv4 literals reach this adapter.
    return subprocess.run(  # noqa: S603 -- Argument vectors contain no shell or caller-supplied command.
        args, check=True, capture_output=True, text=True, timeout=10
    ).stdout


def container_ips(runner: Runner) -> list[str]:
    """Validate the exact running streamer before deriving its private IPv4s."""
    info = json.loads(runner(["docker", "inspect", TARGET]))[0]
    if (
        info.get("Name") != "/" + TARGET
        or not info.get("State", {}).get("Running")
        or info.get("Config", {}).get("Labels", {}).get("com.docker.compose.service")
        != "ytmusic-streamer"
    ):
        raise ValueError("Refusing a container outside the Soundspan streamer scope")
    addresses = set()
    for network in info["NetworkSettings"]["Networks"].values():
        if not network.get("IPAddress"):
            continue
        address = ipaddress.ip_address(network["IPAddress"])
        if (
            address.version != 4
            or not address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_unspecified
        ):
            raise ValueError("Refusing an unexpected streamer network address")
        addresses.add(str(address))
    if not addresses:
        raise ValueError("The streamer has no scoped IPv4 address")
    return sorted(addresses)


def owned_rules(runner: Runner) -> list[list[str]]:
    """Select exact ownership comments and queue; leave every other rule alone."""
    result = []
    for line in runner(["iptables", "-t", "mangle", "-S"]).splitlines():
        rule = shlex.split(line)
        if len(rule) < 2 or rule[0] != "-A" or rule[1] not in {"OUTPUT", "POSTROUTING"}:
            continue
        if all(
            flag in rule and rule[rule.index(flag) + 1] == value
            for flag, value in [("--comment", OWNER), ("--queue-num", QUEUE), ("-j", "NFQUEUE")]
        ):
            result.append(rule)
    return result


def remove_rules(runner: Runner = run) -> None:
    """Delete only this profile's rules, without flushing tables or chains."""
    for rule in owned_rules(runner):
        runner(["iptables", "-t", "mangle", "-D", *rule[1:]])


def install_rules(runner: Runner = run) -> list[str]:
    """Refresh the owned rules and restore their before-image on partial failure."""
    addresses = container_ips(runner)
    previous = owned_rules(runner)
    tail = [
        "-m",
        "comment",
        "--comment",
        OWNER,
        "-j",
        "NFQUEUE",
        "--queue-num",
        QUEUE,
        "--queue-bypass",
    ]
    rules = [
        ["OUTPUT", "-o", "eth0", "-p", "tcp", "--dport", "443", "-m", "mark", "--mark", MARK, *tail]
    ]
    for address in addresses:
        rules.append(
            [
                "POSTROUTING",
                "-s",
                address + "/32",
                "-o",
                "eth0",
                "-p",
                "udp",
                "--dport",
                "443",
                "-m",
                "mark",
                "!",
                "--mark",
                "0x40000000/0x40000000",
                *tail,
            ]
        )
    try:
        remove_rules(runner)
        for rule in rules:
            runner(["iptables", "-t", "mangle", "-A", *rule])
    except Exception:
        remove_rules(runner)
        for rule in previous:
            runner(["iptables", "-t", "mangle", *rule])
        raise
    return addresses


def queue_ready() -> bool:
    """Check the private queue in the current network namespace only."""
    path = Path("/proc/net/netfilter/nfnetlink_queue")
    return path.exists() and any(
        line.split()[:1] == [QUEUE] for line in path.read_text().splitlines()
    )


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) == 2 else ""
    if action == "check":
        container_ips(run)
        if queue_ready():
            raise RuntimeError("The private Soundspan queue is already occupied")
    elif action == "install":
        for _ in range(40):
            if queue_ready():
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("The private Soundspan queue did not become ready")
        sys.stdout.write(json.dumps({"container": TARGET, "sourceIps": install_rules()}) + "\n")
    elif action == "remove":
        remove_rules()
    else:
        raise SystemExit("usage: soundspan_http3_rules.py check|install|remove")
