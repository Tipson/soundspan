"""Security floors for dependencies loaded by the sidecar interpreter."""

import ssl
from importlib.metadata import version

import brotli
import certifi
from packaging.version import Version


def test_installed_brotli_contains_decoder_security_fix() -> None:
    """Reject a runtime that still loads the pre-CVE-2026-111497 Brotli decoder."""
    minimum = Version("1.2.1")

    assert Version(version("Brotli")) >= minimum
    assert Version(brotli.__version__) >= minimum


def test_installed_certifi_excludes_compromised_emsign_root() -> None:
    """The actual TLS trust store must exclude the compromised emSign root."""
    minimum = Version("2026.10.19")
    context = ssl.create_default_context(cafile=certifi.where())
    common_names = {
        value
        for certificate in context.get_ca_certs()
        for relative_name in certificate["subject"]
        for attribute, value in relative_name
        if attribute == "commonName"
    }

    assert "emSign ECC Root CA - G3" not in common_names
    assert Version(version("certifi")) >= minimum
    assert Version(certifi.__version__) >= minimum
