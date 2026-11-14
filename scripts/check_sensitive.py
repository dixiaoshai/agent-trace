#!/usr/bin/env python3
"""Fail when tracked files look like they contain secrets or personal data.

The scan is intentionally limited to high-confidence patterns so synthetic
fixtures (for example tokens containing ``synthetic``) can be allowlisted
explicitly below. Run it locally before pushing, or let CI run it on every
pull request.

Usage:
    python3 scripts/check_sensitive.py [--root PATH]
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

# High-confidence patterns. Matched values are never printed in full so the
# CI log cannot become the leak it is trying to prevent.
RULES = [
    ("github token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b")),
    ("openai/api key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b")),
    ("aws access key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("google api key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("slack token", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}\b")),
    ("private key", re.compile(r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
    ("url credentials", re.compile(r"https?://[^\s/:@]+:[^\s/@]+@[A-Za-z0-9.-]+")),
    ("personal home path", re.compile(r"/(?:Users|home)/[A-Za-z0-9._-]+/")),
]

SENSITIVE_NAMES = re.compile(
    r"(^|/)(\.env(\..+)?|\.npmrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]+\.(pem|key|p12|pfx|sqlite3?))$"
)

SKIP_DIRS = ("node_modules/", "dist/", "build/", "coverage/", ".agent-trace/", ".agent-archive/")
MAX_BYTES = 2 * 1024 * 1024

# Explicit allowlist for synthetic fixtures and documentation placeholders.
# Entries are (path, rule); a path ending in "/" matches a directory prefix.
# Keep this list minimal: every entry needs a reason, and real credentials or
# real home directories must be removed instead of allowlisted.
ALLOW = [
    ("docs/content-capture.md", "url credentials"),  # user:password@host placeholder
    ("tests/content.test.ts", "github token"),        # synthetic ghp_ fixture
    ("tests/pi.test.ts", "personal home path"),       # /home/user placeholder
    ("tests/titles.test.ts", "personal home path"),   # /home/u placeholder
]


def tracked_files(root):
    output = subprocess.run(
        ["git", "ls-files", "-z"], cwd=root, check=True, capture_output=True
    ).stdout
    for raw in output.split(b"\0"):
        if raw:
            yield raw.decode("utf-8", "surrogateescape")


def allowed(name, label):
    for path, rule in ALLOW:
        if rule != label:
            continue
        if name == path or (path.endswith("/") and name.startswith(path)):
            return True
    return False


def mask(value):
    if len(value) <= 4:
        return "***"
    return f"{value[:4]}***"


def scan(root):
    findings = []
    for name in tracked_files(root):
        if name.startswith(SKIP_DIRS):
            continue
        if SENSITIVE_NAMES.search(name):
            findings.append((name, 0, "sensitive filename", ""))
            continue
        path = Path(root) / name
        try:
            if path.stat().st_size > MAX_BYTES:
                continue
            data = path.read_bytes()
        except OSError:
            continue
        if b"\0" in data:
            continue
        text = data.decode("utf-8", "replace")
        for lineno, line in enumerate(text.splitlines(), 1):
            for label, pattern in RULES:
                match = pattern.search(line)
                if not match:
                    continue
                if allowed(name, label):
                    continue
                findings.append((name, lineno, label, mask(match.group(0))))
    return findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="repository root (default: .)")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    findings = scan(root)
    if not findings:
        print("sensitive scan: clean (%d tracked files)" % sum(1 for _ in tracked_files(root)))
        return 0
    for name, lineno, label, sample in findings:
        location = name if not lineno else "%s:%d" % (name, lineno)
        suffix = " [%s]" % sample if sample else ""
        print("sensitive scan: %s: %s%s" % (location, label, suffix))
    print("sensitive scan: %d finding(s); remove them or add an explicit allowlist" % len(findings))
    return 1


if __name__ == "__main__":
    sys.exit(main())
