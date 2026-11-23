"""Only the named Soundspan container may enter its owned TCP/UDP queues."""

import json
import shlex

import pytest


class Firewall:
    def __init__(self):
        self.rules = [["-A", "OUTPUT", "-p", "tcp", "--dport", "8443", "-j", "ACCEPT"]]
        self.info = {
            "Name": "/soundspan-prod-ytmusic",
            "State": {"Running": True},
            "Config": {"Labels": {"com.docker.compose.service": "ytmusic-streamer"}},
            "NetworkSettings": {
                "Networks": {"a": {"IPAddress": "172.30.121.11"}, "b": {"IPAddress": "172.20.0.5"}}
            },
        }
        self.fail_at = None
        self.adds = 0

    def run(self, args):
        if args[0] == "docker":
            return json.dumps([self.info])
        assert args[:3] == ["iptables", "-t", "mangle"]
        action, *rest = args[3:]
        if action == "-S":
            return "\n".join(shlex.join(rule) for rule in self.rules)
        if action == "-A":
            self.adds += 1
            if self.adds == self.fail_at:
                raise RuntimeError("injected kernel rule failure")
            self.rules.append([action, *rest])
        elif action == "-D":
            self.rules.remove(["-A", *rest])
        else:
            raise AssertionError(action)
        return ""


def test_install_and_remove_leave_unrelated_firewall_unchanged():
    from scripts.ops.soundspan_http3_rules import install_rules, remove_rules

    firewall = Firewall()
    original = list(firewall.rules)
    assert install_rules(firewall.run) == ["172.20.0.5", "172.30.121.11"]
    owned = firewall.rules[1:]
    assert len(owned) == 3
    assert all("--queue-bypass" in rule for rule in owned)
    assert {r[r.index("-s") + 1] for r in owned if "-s" in r} == {
        "172.20.0.5/32",
        "172.30.121.11/32",
    }
    remove_rules(firewall.run)
    remove_rules(firewall.run)
    assert firewall.rules == original


def test_unknown_container_is_rejected_before_any_mutation():
    from scripts.ops.soundspan_http3_rules import install_rules

    firewall = Firewall()
    original = list(firewall.rules)
    firewall.info["Name"] = "/some-other-service"
    with pytest.raises(ValueError):
        install_rules(firewall.run)
    assert firewall.rules == original


def test_partial_rule_failure_restores_previous_owned_rules():
    from scripts.ops.soundspan_http3_rules import install_rules

    firewall = Firewall()
    install_rules(firewall.run)
    original = list(firewall.rules)
    firewall.info["NetworkSettings"]["Networks"]["b"]["IPAddress"] = "172.20.0.6"
    firewall.fail_at = firewall.adds + 2
    with pytest.raises(RuntimeError):
        install_rules(firewall.run)
    assert firewall.rules == original
