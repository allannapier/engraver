"""Starting-point settings for a 10 W optical-output 455 nm diode laser.

These are sensible first guesses, not measured values for any one machine.
Material batches, focus and lens cleanliness all shift the right numbers, so
the app presents them as a place to start a test from.

Speeds are mm/min, power is percent, interval is mm between fill lines.
"""

from __future__ import annotations

MATERIALS: list[dict] = [
    {
        "id": "plywood-3",
        "name": "Plywood (basswood/birch), 3 mm",
        "engrave": {"mode": "fill", "speed": 6000, "power": 50, "passes": 1, "interval": 0.1},
        "score": {"mode": "line", "speed": 3000, "power": 35, "passes": 1},
        "cut": {"mode": "line", "speed": 300, "power": 100, "passes": 2},
        "notes": "Air assist makes cuts cleaner and reduces charring. Mask the surface with paper tape to avoid smoke stains.",
    },
    {
        "id": "plywood-6",
        "name": "Plywood, 6 mm",
        "engrave": {"mode": "fill", "speed": 6000, "power": 50, "passes": 1, "interval": 0.1},
        "score": {"mode": "line", "speed": 3000, "power": 35, "passes": 1},
        "cut": {"mode": "line", "speed": 150, "power": 100, "passes": 4},
        "notes": "Near the limit for 10 W. Glue layers vary a lot between sheets; expect to tune passes.",
    },
    {
        "id": "solid-wood",
        "name": "Solid wood (pine, beech, oak)",
        "engrave": {"mode": "fill", "speed": 5000, "power": 60, "passes": 1, "interval": 0.1},
        "score": {"mode": "line", "speed": 2500, "power": 40, "passes": 1},
        "cut": {"mode": "line", "speed": 200, "power": 100, "passes": 3},
        "notes": "Cut settings are for about 4 mm. Grain burns unevenly: resinous softwood darkens faster than hardwood.",
    },
    {
        "id": "mdf-3",
        "name": "MDF, 3 mm",
        "engrave": {"mode": "fill", "speed": 5000, "power": 60, "passes": 1, "interval": 0.1},
        "score": {"mode": "line", "speed": 2500, "power": 45, "passes": 1},
        "cut": {"mode": "line", "speed": 200, "power": 100, "passes": 3},
        "notes": "Dense and smoky. Ventilate well.",
    },
    {
        "id": "cardboard",
        "name": "Cardboard, 2-3 mm",
        "engrave": {"mode": "fill", "speed": 8000, "power": 20, "passes": 1, "interval": 0.12},
        "score": {"mode": "line", "speed": 4000, "power": 15, "passes": 1},
        "cut": {"mode": "line", "speed": 1000, "power": 80, "passes": 1},
        "notes": "Catches fire easily. Never leave it unattended.",
    },
    {
        "id": "cardstock",
        "name": "Paper and cardstock",
        "engrave": {"mode": "fill", "speed": 8000, "power": 10, "passes": 1, "interval": 0.12},
        "score": {"mode": "line", "speed": 5000, "power": 10, "passes": 1},
        "cut": {"mode": "line", "speed": 2500, "power": 50, "passes": 1},
        "notes": "Catches fire easily. Start low and work up.",
    },
    {
        "id": "leather",
        "name": "Leather, vegetable tanned, 2 mm",
        "engrave": {"mode": "fill", "speed": 6000, "power": 35, "passes": 1, "interval": 0.1},
        "score": {"mode": "line", "speed": 3000, "power": 25, "passes": 1},
        "cut": {"mode": "line", "speed": 300, "power": 100, "passes": 2},
        "notes": "Use vegetable-tanned leather only. Chrome-tanned leather and most faux leather (PVC/PU) give off toxic fumes.",
    },
    {
        "id": "acrylic-dark-3",
        "name": "Acrylic, black or dark opaque, 3 mm",
        "engrave": {"mode": "fill", "speed": 5000, "power": 50, "passes": 1, "interval": 0.1},
        "score": {"mode": "line", "speed": 2000, "power": 50, "passes": 1},
        "cut": {"mode": "line", "speed": 150, "power": 100, "passes": 3},
        "notes": "Only dark opaque acrylic works. Clear, white and blue acrylic let 455 nm light straight through and won't cut or engrave.",
    },
    {
        "id": "anodised-aluminium",
        "name": "Anodised aluminium",
        "engrave": {"mode": "fill", "speed": 3000, "power": 80, "passes": 1, "interval": 0.08},
        "score": {"mode": "line", "speed": 1500, "power": 80, "passes": 1},
        "cut": None,
        "notes": "Bleaches the dye layer to a pale mark. Can't cut metal.",
    },
    {
        "id": "stainless",
        "name": "Stainless steel",
        "engrave": {"mode": "fill", "speed": 1200, "power": 100, "passes": 1, "interval": 0.06},
        "score": {"mode": "line", "speed": 800, "power": 100, "passes": 1},
        "cut": None,
        "notes": "Bare steel marks faintly at 10 W; a marking spray or paste gives a much darker result. Reflective: wear your goggles.",
    },
    {
        "id": "slate",
        "name": "Slate and dark stone",
        "engrave": {"mode": "fill", "speed": 3000, "power": 80, "passes": 1, "interval": 0.1},
        "score": {"mode": "line", "speed": 1500, "power": 80, "passes": 1},
        "cut": None,
        "notes": "Marks light grey. A coat of mineral oil afterwards raises the contrast.",
    },
    {
        "id": "glass",
        "name": "Glass and ceramic tile (coated)",
        "engrave": {"mode": "fill", "speed": 2000, "power": 85, "passes": 1, "interval": 0.1},
        "score": {"mode": "line", "speed": 1200, "power": 85, "passes": 1},
        "cut": None,
        "notes": "A diode laser passes through bare glass. Coat it first with black tempera or matt paint, engrave, then wash it off.",
    },
    {
        "id": "cork",
        "name": "Cork, 2-3 mm",
        "engrave": {"mode": "fill", "speed": 6000, "power": 30, "passes": 1, "interval": 0.12},
        "score": {"mode": "line", "speed": 3000, "power": 25, "passes": 1},
        "cut": {"mode": "line", "speed": 600, "power": 80, "passes": 1},
        "notes": "Burns fast and dark.",
    },
    {
        "id": "fabric",
        "name": "Cotton, denim and felt",
        "engrave": {"mode": "fill", "speed": 6000, "power": 20, "passes": 1, "interval": 0.12},
        "score": {"mode": "line", "speed": 3000, "power": 20, "passes": 1},
        "cut": {"mode": "line", "speed": 1500, "power": 60, "passes": 1},
        "notes": "Natural fibres only. Keep it flat and taut.",
    },
]

# Materials that must not go under the laser, with the reason.
NEVER = [
    {"name": "PVC, vinyl, pleather", "why": "releases hydrogen chloride gas, which is toxic and corrodes the machine"},
    {"name": "ABS", "why": "releases cyanide compounds and melts rather than cuts"},
    {"name": "Polycarbonate (Lexan)", "why": "burns and discolours, with toxic smoke"},
    {"name": "Fibreglass and carbon fibre", "why": "the resin gives off toxic fumes"},
    {"name": "Chrome-tanned leather", "why": "releases chromium compounds"},
    {"name": "Polystyrene and polypropylene foam", "why": "catches fire and drips burning plastic"},
    {"name": "Mirrors and polished bare metal", "why": "reflect the beam back at the laser module and at you"},
]


def as_prompt_table() -> str:
    """Compact text version of the table for the assistant's system prompt."""
    rows = []
    for mat in MATERIALS:
        parts = [mat["name"] + ":"]
        for op in ("engrave", "score", "cut"):
            cfg = mat.get(op)
            if not cfg:
                parts.append(f"{op} not possible;")
                continue
            extra = f", interval {cfg['interval']} mm" if "interval" in cfg else ""
            parts.append(f"{op} {cfg['mode']} {cfg['speed']} mm/min {cfg['power']}% x{cfg['passes']}{extra};")
        parts.append(mat["notes"])
        rows.append(" ".join(parts))
    never = "; ".join(f"{item['name']} ({item['why']})" for item in NEVER)
    return "\n".join(rows) + f"\nNever laser: {never}."
