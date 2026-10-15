"""The assistant: design generation, tweaks and settings advice through LiteLLM.

The model can only change the design and the layer settings, by returning
actions the browser applies to the canvas. It has no tool that moves the head
or fires the laser, by design.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from typing import Any

from .config import LLMSettings
from .gcode import MachineProfile
from .materials import as_prompt_table

Completion = Callable[..., Awaitable[Any]]


class AssistantError(Exception):
    """Something the user can fix (missing model, bad key, provider error)."""


SYSTEM_PROMPT = """You are the design and settings assistant inside Engraver, a desktop app that drives a {name} diode laser engraver/cutter: 455 nm blue diode, about 10 W optical output, bed {bed_w:.0f} × {bed_h:.0f} mm, maximum speed {max_feed:.0f} mm/min.

You help in three ways: creating new designs, changing existing ones, and choosing laser settings for a material. You act by calling tools; the app applies them to the canvas and layer list straight away. You cannot move the laser head or start a job. The person does that themselves.

How the app models a job
- The canvas is the bed. Positions are in mm from the front-left corner: x to the right, y away from the front. A design's position is the front-left corner of its bounding box.
- Every design sits on one layer. A layer has a mode and settings that apply to everything on it.
  - "fill" mode engraves: the design is rasterised and scanned line by line. Dark areas burn, white and transparent areas don't. Settings: speed (mm/min), power (%), passes, interval (mm between scan lines), image_mode ("threshold" for crisp black and white, "dither" for photos, "grayscale" to vary power with darkness).
  - "line" mode traces vector outlines once each, for scoring or cutting. Settings: speed, power, passes.
- A typical project has an engrave layer (fill) and a cut layer (line). Put a design on the layer whose mode suits it, creating a layer if there isn't one.

Writing SVG for a laser
- Return a complete standalone <svg> with xmlns and a viewBox. viewBox units are arbitrary; the app scales the design to the width_mm you give.
- Use only: svg, g, path, rect, circle, ellipse, line, polyline, polygon, and text (fill mode only). Style with presentation attributes. No CSS, classes, gradients, filters, masks, clip paths, images, scripts or external references.
- Fill-mode designs: solid black (#000) shapes on a transparent background. Keep detail bolder than about 0.3 mm at the final size. Use greys only when the layer will use grayscale or dither.
- Line-mode designs: fill="none" stroke="#000". The laser follows the centre of every stroke once, whatever the stroke width, so never stack duplicate lines, and close any outline that is meant to be cut out. Text does not work in line mode; draw letter shapes as paths or put the text on a fill layer.
- Draw with care: balanced composition, smooth curves, consistent stroke weights. A design that will be cut out needs its pieces connected or deliberately separate.
- Plan before drawing. Count what is needed (every piece, every repeat), then work out the grid or positions as numbers and place every shape from those numbers. Don't eyeball coordinates.
- The app crops each design to what it draws and scales that to width_mm, so two separate designs only line up if you tie them together. When parts on different layers must line up (an engraving on a cut-out piece, a score line inside a cut outline):
  - Draw them in one shared coordinate system: the same viewBox, with each engraving centred on the same coordinates as the outline it belongs to.
  - Add or replace the outline first with its size and position. Then add or replace the other part with align_with set to the outline's design id (or, if you added it in this same reply, its name). The app then places it so the shared coordinates coincide, ignoring width_mm, x_mm and y_mm.
  - When you change one part, replace the other with align_with too, so they stay matched. Each design's SVG is in the app state below.
- Think about the real object. Ask for the finished size if it matters and wasn't given, otherwise pick a sensible size for the item and say what you chose.

Choosing settings
{library}- Generic starting points for this class of laser (speed mm/min, power %, passes):
{materials}
- Treat the generic values as starting points. Give one concrete recommendation, apply it with set_layer, and say briefly what to adjust if the result is too light, too dark or doesn't cut through.
- When a setting is a guess, say so and point to the app's test grid (Design tab, Material, Test grid): it burns squares across a range of speed and power on scrap, and the person picks the best one to save to their materials.
- Cutting needs slow speed and high power, often several passes. Engraving needs high speed and moderate power.
- Power limits: never set a layer above 90 % power, even if a table value or the person's description suggests it. Running a diode at full power wears it out faster and raises the fire risk. If a table value is above 90 %, use 90 % and compensate with slower speed or more passes.
- When the person says a job takes too many passes or isn't cutting or marking deeply enough, don't raise power to the maximum. First slow the speed, then add a pass, and raise power only in small steps (about 10 %) up to the 90 % ceiling. Keep engraving at or below 60 % unless a tested setting says otherwise. Say what you changed and why.
- If the person insists on more than 90 %, explain the limit briefly and suggest the test grid instead of setting it.
- If asked about a material on the never-laser list, say why it's unsafe and don't supply settings for it. Mention ventilation, eye protection or fire risk only where it is specifically relevant, in a sentence, not as boilerplate.

Style
- Write plain text. The app shows **bold** and `code` and nothing else: no headings, tables, links or nested lists.
- Always write a reply, even when you call tools: say what you changed and why in a sentence or two, and anything the person should check. Never answer with tool calls alone. Every tool also takes a note: one plain sentence for the person on what that change does.
- Treat the conversation as a discussion. If the person asks a question, floats an idea, asks for your opinion or the request is open-ended, answer in words and suggest an approach without calling tools; make the change once they agree or ask for it.
- Be brief and practical. Say what you did and anything the person needs to decide. Don't describe SVG code or list every value you set unless asked.
- When changing an existing design, use replace_design on that design rather than adding a new one, and keep what the person didn't ask to change.
"""

NOTE = {"type": "string", "description": "One sentence for the person: what this change does and why."}
ALIGN_WITH = {
    "type": "string",
    "description": (
        "Id of a design drawn in the same viewBox coordinates (or the name of one added earlier in this reply). "
        "This design is placed so the shared coordinates line up with it; width_mm, x_mm and y_mm are ignored."
    ),
}

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "add_design",
            "description": "Add a new design to the canvas from SVG markup.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Short name shown in the app."},
                    "svg": {"type": "string", "description": "Complete standalone SVG document."},
                    "width_mm": {"type": "number", "description": "Finished width on the material in mm."},
                    "mode": {
                        "type": "string",
                        "enum": ["fill", "line"],
                        "description": "fill = engrave, line = score or cut.",
                    },
                    "layer_id": {
                        "type": "string",
                        "description": "Existing layer to put it on. Omit to use the first layer with a matching mode, or a new one.",
                    },
                    "x_mm": {"type": "number", "description": "Left edge, mm from the bed's left. Omit to centre."},
                    "y_mm": {"type": "number", "description": "Front edge, mm from the bed's front. Omit to centre."},
                    "align_with": ALIGN_WITH,
                    "note": NOTE,
                },
                "required": ["name", "svg", "width_mm", "mode", "note"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "replace_design",
            "description": (
                "Replace the artwork of an existing design, keeping its centre, width and layer "
                "(or its placement relative to align_with, if given)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "design_id": {"type": "string"},
                    "svg": {"type": "string", "description": "Complete standalone SVG document."},
                    "name": {"type": "string"},
                    "align_with": ALIGN_WITH,
                    "note": NOTE,
                },
                "required": ["design_id", "svg", "note"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "transform_design",
            "description": "Move, resize or rotate an existing design. Omitted values stay as they are. Height follows width unless both are given.",
            "parameters": {
                "type": "object",
                "properties": {
                    "design_id": {"type": "string"},
                    "x_mm": {"type": "number"},
                    "y_mm": {"type": "number"},
                    "width_mm": {"type": "number"},
                    "height_mm": {"type": "number"},
                    "rotation_deg": {"type": "number"},
                    "layer_id": {"type": "string", "description": "Move the design to this layer."},
                    "note": NOTE,
                },
                "required": ["design_id", "note"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_layer",
            "description": "Create a layer with its laser settings.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "mode": {"type": "string", "enum": ["fill", "line"]},
                    "speed": {"type": "number", "description": "mm/min"},
                    "power": {"type": "number", "description": "percent, 0-100"},
                    "passes": {"type": "integer"},
                    "interval": {"type": "number", "description": "fill only: mm between scan lines"},
                    "image_mode": {"type": "string", "enum": ["threshold", "dither", "grayscale"]},
                    "note": NOTE,
                },
                "required": ["name", "mode", "speed", "power", "note"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_layer",
            "description": "Change settings on an existing layer. Omitted values stay as they are.",
            "parameters": {
                "type": "object",
                "properties": {
                    "layer_id": {"type": "string"},
                    "name": {"type": "string"},
                    "mode": {"type": "string", "enum": ["fill", "line"]},
                    "speed": {"type": "number", "description": "mm/min"},
                    "power": {"type": "number", "description": "percent, 0-100"},
                    "passes": {"type": "integer"},
                    "interval": {"type": "number"},
                    "image_mode": {"type": "string", "enum": ["threshold", "dither", "grayscale"]},
                    "note": NOTE,
                },
                "required": ["layer_id", "note"],
            },
        },
    },
]

ACTION_NAMES = {tool["function"]["name"] for tool in TOOLS}
SVG_BLOCK_RE = re.compile(r"```(?:svg|xml|html)?\s*(<svg[\s\S]*?</svg>)\s*```", re.IGNORECASE)
MAX_HISTORY = 24
MAX_SVG_CONTEXT = 40_000


def system_prompt(machine: MachineProfile, library: str = "") -> str:
    if library:
        own = (
            "- The person's own materials, saved from this machine. These take priority over the generic values below. "
            "A setting picked from a test grid is known to work here: use it as it is unless the person wants a different result.\n"
            f"{library}\n"
        )
    else:
        own = "- The person hasn't saved any materials of their own yet.\n"
    return SYSTEM_PROMPT.format(
        name=machine.name,
        bed_w=machine.bed_w,
        bed_h=machine.bed_h,
        max_feed=machine.max_feed,
        materials=as_prompt_table(),
        library=own,
    )


def trim_context(context: dict) -> dict:
    """The canvas state with its artwork kept within MAX_SVG_CONTEXT characters."""
    ctx = dict(context or {})
    selected = ctx.get("selected")
    if selected and isinstance(selected.get("svg"), str) and len(selected["svg"]) > MAX_SVG_CONTEXT:
        ctx["selected"] = {**selected, "svg": selected["svg"][:MAX_SVG_CONTEXT] + "…[truncated]"}
    # Every design's artwork goes along so parts can be matched up, within a budget; the rest just say so.
    designs = ctx.get("designs")
    if isinstance(designs, list):
        budget = MAX_SVG_CONTEXT
        kept = []
        for design in designs:
            if isinstance(design, dict) and isinstance(design.get("svg"), str):
                if len(design["svg"]) <= budget:
                    budget -= len(design["svg"])
                else:
                    design = {**design, "svg": "(too large to include; select it to see it)"}
            kept.append(design)
        ctx["designs"] = kept
    return ctx


def _context_text(context: dict) -> str:
    return "Current state of the app (for reference, not written by the person):\n" + json.dumps(
        trim_context(context), separators=(",", ":")
    )


def build_messages(
    machine: MachineProfile,
    history: list[dict],
    context: dict,
    image: str | None,
    library: str = "",
    reference: str | None = None,
) -> list[dict]:
    messages: list[dict] = [{"role": "system", "content": system_prompt(machine, library)}]
    turns = [m for m in history if m.get("role") in ("user", "assistant") and m.get("content")][-MAX_HISTORY:]
    if not turns or turns[-1]["role"] != "user":
        raise AssistantError("Type a message first.")
    for turn in turns[:-1]:
        messages.append({"role": turn["role"], "content": str(turn["content"])})
    last = str(turns[-1]["content"])
    text = f"{last}\n\n{_context_text(context)}"
    pictures = []
    if reference:
        text += (
            "\n\nThe person attached a reference picture to guide the design. It is not on the canvas and "
            "can't be engraved as it is: use it for shapes, style and layout."
        )
        pictures.append({"type": "image_url", "image_url": {"url": reference}})
    if image:
        text += (
            "\n\nThe last attached image is the canvas as it looks now."
            if reference
            else "\n\nThe attached image is the canvas as it looks now."
        )
        pictures.append({"type": "image_url", "image_url": {"url": image}})
    if pictures:
        messages.append({"role": "user", "content": [{"type": "text", "text": text}, *pictures]})
    else:
        messages.append({"role": "user", "content": text})
    return messages


def _friendly(exc: Exception, api_key: str) -> str:
    text = str(exc) or exc.__class__.__name__
    if api_key:
        text = text.replace(api_key, "•••")
    name = exc.__class__.__name__
    if "Authentication" in name:
        return "The provider rejected the API key. Check it in Setup."
    if "NotFound" in name:
        return f"The provider doesn't know that model. Check the model name in Setup. ({text[:160]})"
    if "RateLimit" in name:
        return "The provider is rate-limiting requests. Wait a moment and try again."
    if "Timeout" in name:
        return "The provider took too long to answer. Try again."
    if "APIConnection" in name or "Connection error" in text:
        return f"Couldn't reach the provider. Check your connection and the base URL in Setup. ({text[:160]})"
    return f"The provider returned an error: {text[:300]}"


async def _default_completion(**kwargs):
    import litellm  # slow to import, so only when the assistant is first used

    litellm.drop_params = True  # ignore parameters a provider doesn't support
    litellm.suppress_debug_info = True  # no "give feedback" banners in the terminal
    return await litellm.acompletion(**kwargs)


def _extract(response) -> tuple[str, list[dict]]:
    message = response.choices[0].message
    text = (getattr(message, "content", None) or "").strip()
    actions: list[dict] = []
    for call in getattr(message, "tool_calls", None) or []:
        name = call.function.name
        if name not in ACTION_NAMES:
            continue
        try:
            args = json.loads(call.function.arguments or "{}")
        except json.JSONDecodeError:
            continue
        if isinstance(args, dict):
            actions.append({"type": name, **args})
    return text, actions


def _svg_fallback(text: str, context: dict) -> tuple[str, list[dict]]:
    """Models without tool calling answer with SVG in a code block; turn that into an action."""
    actions = []
    selected = (context or {}).get("selected")
    for i, match in enumerate(SVG_BLOCK_RE.finditer(text)):
        svg = match.group(1)
        if selected and i == 0:
            actions.append({"type": "replace_design", "design_id": selected.get("id"), "svg": svg})
        else:
            mode = "line" if 'fill="none"' in svg and "stroke=" in svg else "fill"
            actions.append({"type": "add_design", "name": "Design", "svg": svg, "width_mm": 80, "mode": mode})
    if actions:
        text = SVG_BLOCK_RE.sub("", text).strip()
    return text, actions


def _describe(actions: list[dict]) -> str:
    """A reply for when the model changed things but said nothing: its per-change notes, or a plain list."""
    notes = [a["note"].strip() for a in actions if isinstance(a.get("note"), str) and a["note"].strip()]
    if notes:
        return " ".join(dict.fromkeys(n if n.endswith((".", "!", "?")) else n + "." for n in notes))
    verbs = {
        "add_design": "added a design",
        "replace_design": "replaced a design",
        "transform_design": "moved or resized a design",
        "add_layer": "added a layer",
        "set_layer": "changed layer settings",
    }
    done = list(dict.fromkeys(verbs.get(a["type"], "made a change") for a in actions))
    return "I " + ", ".join(done) + ". The model didn't explain; ask what it did or why."


async def chat(
    settings: LLMSettings,
    machine: MachineProfile,
    history: list[dict],
    context: dict,
    image: str | None = None,
    completion: Completion | None = None,
    library: str = "",
    reference: str | None = None,
) -> dict:
    if not settings.model:
        raise AssistantError("No model is set up yet. Add your provider details in Setup.")
    complete = completion or _default_completion
    use_image = image if settings.vision else None
    base = {
        "model": settings.model,
        "max_tokens": settings.max_tokens,
        "timeout": 180,
    }
    if settings.api_key:
        base["api_key"] = settings.api_key
    if settings.api_base:
        base["api_base"] = settings.api_base

    async def attempt(with_tools: bool, with_image: bool):
        messages = build_messages(
            machine, history, context, use_image if with_image else None, library, reference=reference
        )
        kwargs = dict(base, messages=messages)
        if with_tools:
            kwargs.update(tools=TOOLS, tool_choice="auto")
        else:
            messages[0]["content"] += (
                "\n\nTools are unavailable in this session. To add or change a design, put the complete SVG in a "
                "```svg code block. If a design is selected, the first block replaces it. State any settings in plain text."
            )
        return await complete(**kwargs)

    # Some local or small models reject tools or images; degrade one step at a time.
    plans = [(True, bool(use_image)), (True, False), (False, False)] if use_image else [(True, False), (False, False)]
    error: Exception | None = None
    for with_tools, with_image in plans:
        try:
            response = await attempt(with_tools, with_image)
            break
        except AssistantError:
            raise
        except Exception as exc:
            error = exc
            name = exc.__class__.__name__
            # Only capability problems are worth retrying in a simpler form.
            if not any(
                key in name for key in ("BadRequest", "UnsupportedParams", "NotSupported", "UnprocessableEntity")
            ):
                raise AssistantError(_friendly(exc, settings.api_key)) from exc
    else:
        if reference:
            # The reference picture is never dropped silently: the person asked the model to look at it.
            raise AssistantError(
                f"{settings.model} couldn't take the reference picture. It may not read images: "
                "choose a model that does in Setup, or remove the picture and try again."
            ) from error
        raise AssistantError(_friendly(error, settings.api_key)) from error

    text, actions = _extract(response)
    if not actions:
        text, actions = _svg_fallback(text, context)
    if not text and actions:
        text = _describe(actions)
    return {"text": text, "actions": actions}


async def test_connection(settings: LLMSettings, completion: Completion | None = None) -> str:
    if not settings.model:
        raise AssistantError("Enter a model name first.")
    complete = completion or _default_completion
    kwargs = {
        "model": settings.model,
        "max_tokens": 20,
        "timeout": 30,
        "messages": [{"role": "user", "content": "Reply with the single word: ready"}],
    }
    if settings.api_key:
        kwargs["api_key"] = settings.api_key
    if settings.api_base:
        kwargs["api_base"] = settings.api_base
    try:
        response = await complete(**kwargs)
    except Exception as exc:
        raise AssistantError(_friendly(exc, settings.api_key)) from exc
    return (response.choices[0].message.content or "").strip()
