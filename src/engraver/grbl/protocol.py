"""GRBL 1.1 wire protocol helpers: realtime bytes, status parsing, error text."""

from __future__ import annotations

SOFT_RESET = b"\x18"
STATUS_QUERY = b"?"
FEED_HOLD = b"!"
CYCLE_START = b"~"
JOG_CANCEL = b"\x85"

ERRORS = {
    1: "Expected a command letter",
    2: "Bad number format",
    3: "Invalid $ statement",
    4: "Negative value",
    5: "Homing is not enabled on this machine",
    8: "Command needs the machine to be idle",
    9: "Machine is locked (alarm). Unlock it first",
    10: "Soft limits need homing enabled",
    11: "Line too long",
    15: "Jog target exceeds machine travel",
    16: "Invalid jog command",
    17: "Laser mode needs PWM output",
    20: "Unsupported G-code command",
    21: "More than one command from the same modal group",
    22: "Feed rate has not been set",
    23: "Command needs an integer value",
    24: "Two commands both need axis words",
    25: "Repeated G-code word",
    26: "No axis words found",
    27: "Invalid line number",
    28: "Missing a required value",
    31: "Axis word not used by this command",
    33: "Invalid motion target",
}

ALARMS = {
    1: "Hard limit triggered. Position is probably lost",
    2: "Move would exceed machine travel",
    3: "Reset while moving. Position is probably lost",
    6: "Homing failed: reset during cycle",
    8: "Homing failed: could not clear the limit switch",
    9: "Homing failed: limit switch not found",
}


def error_text(code: int) -> str:
    return ERRORS.get(code, f"GRBL error {code}")


def alarm_text(code: int) -> str:
    return ALARMS.get(code, f"GRBL alarm {code}")


def _floats(text: str) -> list[float]:
    out = []
    for part in text.split(","):
        try:
            out.append(float(part))
        except ValueError:
            out.append(0.0)
    return out


def parse_status(line: str) -> dict | None:
    """Parse `<Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:...>` into a dict.

    Returns only the fields present; the caller keeps the last known WCO
    because GRBL sends it only every few reports.
    """
    line = line.strip()
    if not (line.startswith("<") and line.endswith(">")):
        return None
    fields = line[1:-1].split("|")
    if not fields or not fields[0]:
        return None
    state, _, sub = fields[0].partition(":")
    out: dict = {"state": state, "substate": int(sub) if sub.isdigit() else None}
    for field in fields[1:]:
        key, _, value = field.partition(":")
        if key == "MPos":
            out["mpos"] = _floats(value)
        elif key == "WPos":
            out["wpos"] = _floats(value)
        elif key == "WCO":
            out["wco"] = _floats(value)
        elif key == "FS":
            nums = _floats(value)
            out["feed"] = nums[0] if nums else 0.0
            out["power"] = nums[1] if len(nums) > 1 else 0.0
        elif key == "F":
            out["feed"] = _floats(value)[0]
        elif key == "Bf":
            out["buf"] = [int(v) for v in _floats(value)]
    return out


def parse_setting(line: str) -> tuple[int, float] | None:
    """Parse a `$110=6000.000` line from a `$$` dump."""
    if not line.startswith("$") or "=" not in line:
        return None
    key, _, value = line[1:].partition("=")
    try:
        return int(key), float(value.split()[0])
    except (ValueError, IndexError):
        return None
