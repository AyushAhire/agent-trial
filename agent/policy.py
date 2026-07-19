"""
AgentTrail - Policy & Detection Engine
Rule-based (no ML) so it's reliable under demo conditions.

Responsibilities:
1. Tag data with sensitivity labels when it enters the agent (classify_content)
2. Decide whether a tool call should be allowed/blocked/paused (evaluate_call)
"""

import fnmatch
import re
from dataclasses import dataclass, field
from enum import Enum
from urllib.parse import urlparse


class Tag(str, Enum):
    PII = "pii"
    SECRET = "secret"
    INTERNAL_ONLY = "internal_only"
    USER_UPLOADED = "user_uploaded"
    PUBLIC = "public"


class Decision(str, Enum):
    ALLOW = "allow"
    BLOCK = "block"
    PENDING_CONFIRM = "pending_confirm"


# --- Detection patterns (hackathon-scope: regex/keyword, not ML) ---

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
PHONE_RE = re.compile(r"\b(\+?\d{1,3}[-.\s]?)?\(?\d{3,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b")
# Common secret-shaped tokens: API keys, bearer tokens, AWS-style keys, generic hex/base64 secrets
SECRET_RE = re.compile(
    r"(sk-[a-zA-Z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{35}|"
    r"ghp_[a-zA-Z0-9]{20,}|gsk_[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9\-_\.]{20,}|"
    r"[a-fA-F0-9]{32,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)"
)
INTERNAL_MARKER_RE = re.compile(r"(confidential|internal[\s\-]?use[\s\-]?only|do not distribute)", re.I)

DANGEROUS_SHELL_RE = re.compile(
    r"(rm\s+-rf\s+/|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh|:\(\)\{.*\};:|"
    r"chmod\s+777|>\s*/dev/sd|mkfs\.|dd\s+if=)"
)

# Domains considered inside the trust boundary. Extend as needed for the demo.
ALLOWLISTED_DOMAINS = {
    "localhost",
    "127.0.0.1",
    "internal.local",
    "api.your-own-service.com",  # placeholder: swap for your real internal API host
}

# Hard path denylist for the Claude Code integration (Feature F, PRD 4.3):
# admin codebase, env files, and secrets are off-limits regardless of taint
# state. "dir/**" matches any path with that directory as a path component;
# a bare glob (no "/") matches against the filename only.
DENY_PATH_PATTERNS = [
    "admin/**",
    ".env*",
    "secrets/**",
]


def check_path_denylist(path: str):
    """Return a reason string if `path` matches a hard-denylisted pattern,
    else None. Works for both absolute and relative paths."""
    if not path:
        return None
    parts = [p for p in path.replace("\\", "/").split("/") if p]
    basename = parts[-1] if parts else path

    for pattern in DENY_PATH_PATTERNS:
        if pattern.endswith("/**"):
            dirname = pattern[:-3]
            if dirname in parts[:-1]:
                return f"path_denylist:{pattern}"
        elif fnmatch.fnmatch(basename, pattern):
            return f"path_denylist:{pattern}"
    return None


# Catches a denylisted path being referenced INSIDE a shell command (cat,
# grep, find, sed, ...) rather than passed as a tool's own file-path
# argument. Without this, "Read .env" gets denied but "grep ... .env" via
# run_shell sails through evaluate_call() with the same effective outcome
# (found via live testing: Claude Code fell back to `grep`/`find` on .env
# after a direct Read was denied, and that path wasn't covered).
DENY_COMMAND_TOKEN_RE = re.compile(r"(?:^|[\s'\"/])(\.env\S*|admin/|secrets/)", re.I)


def check_command_denylist(command: str):
    """Return a reason string if a shell command string references a
    denylisted path anywhere in it, else None."""
    if not command:
        return None
    match = DENY_COMMAND_TOKEN_RE.search(command)
    if match:
        return f"path_denylist:shell_reference:{match.group(1)}"
    return None


@dataclass
class ClassificationResult:
    tags: set = field(default_factory=set)

    def as_list(self):
        return sorted(t.value for t in self.tags)


@dataclass
class PolicyResult:
    decision: Decision
    risk_score: int
    reasons: list = field(default_factory=list)


def classify_content(text: str, source_hint: str = "") -> ClassificationResult:
    """Tag a piece of content (e.g. a file's contents, an API response body)
    with sensitivity labels. Called at the point data ENTERS the agent."""
    tags = set()
    if not text:
        return ClassificationResult(tags)

    if EMAIL_RE.search(text) or PHONE_RE.search(text):
        tags.add(Tag.PII)
    if SECRET_RE.search(text):
        tags.add(Tag.SECRET)
    if INTERNAL_MARKER_RE.search(text):
        tags.add(Tag.INTERNAL_ONLY)
    if "upload" in source_hint.lower():
        tags.add(Tag.USER_UPLOADED)
    if not tags:
        tags.add(Tag.PUBLIC)
    return ClassificationResult(tags)


def _is_external(target: str) -> bool:
    """Best-effort check: is this tool target (url/path/host) outside the
    trust boundary?"""
    parsed = urlparse(target if "://" in target else f"//{target}")
    host = parsed.hostname or target
    return host not in ALLOWLISTED_DOMAINS


def evaluate_call(tool_name: str, target: str, params: dict, inherited_tags: set) -> PolicyResult:
    """Core policy decision, run BEFORE a tool call executes.

    tool_name: e.g. "call_api", "write_file", "run_shell"
    target: url / path / command string being acted on
    inherited_tags: taint tags propagated from upstream spans in this trace
    """
    reasons = []
    risk = 0

    # 0. Hard path denylist (admin/**, .env*, secrets/**) for direct file
    # access -> block regardless of taint. Mirrors the Claude Code hook's
    # path rule (policy.check_path_denylist) so both front-ends get the
    # same protection -- found via live testing that the toy agent could
    # read .env directly with zero resistance while Claude Code couldn't.
    if tool_name in ("read_file", "write_file"):
        path_reason = check_path_denylist(target)
        if path_reason:
            return PolicyResult(Decision.BLOCK, 100, [path_reason])

    # 1. Dangerous shell patterns -> always block regardless of taint
    if tool_name == "run_shell" and DANGEROUS_SHELL_RE.search(target):
        return PolicyResult(Decision.BLOCK, 100, ["dangerous_shell_pattern"])

    # 1b. Shell command referencing a denylisted path (cat/grep/find on
    # .env/admin/secrets) -> block, same as a direct Read/Edit/Write would be.
    if tool_name == "run_shell":
        command_reason = check_command_denylist(target)
        if command_reason:
            return PolicyResult(Decision.BLOCK, 100, [command_reason])

    # 2. Secret data leaving the boundary -> always block
    if Tag.SECRET in inherited_tags and tool_name in ("call_api", "write_file") and _is_external(target):
        return PolicyResult(Decision.BLOCK, 95, ["secret_data_exfil_attempt"])

    # 3. PII crossing the boundary -> pause for confirmation
    if Tag.PII in inherited_tags and tool_name in ("call_api", "write_file") and _is_external(target):
        reasons.append("pii_crossing_trust_boundary")
        risk = max(risk, 70)
        return PolicyResult(Decision.PENDING_CONFIRM, risk, reasons)

    # 4. Internal-only data leaving the boundary -> pause for confirmation
    if Tag.INTERNAL_ONLY in inherited_tags and tool_name in ("call_api", "write_file") and _is_external(target):
        reasons.append("internal_data_crossing_trust_boundary")
        risk = max(risk, 60)
        return PolicyResult(Decision.PENDING_CONFIRM, risk, reasons)

    # 5. Baseline: new/unrecognized external domain, no taint -> allow but flag low risk
    if tool_name in ("call_api", "write_file") and _is_external(target):
        reasons.append("external_destination_untainted")
        risk = 20

    return PolicyResult(Decision.ALLOW, risk, reasons)
