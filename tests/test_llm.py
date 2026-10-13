"""The assistant's system prompt keeps its power guardrails."""

from engraver.config import MachineProfile
from engraver.llm import system_prompt


def test_prompt_caps_power():
    text = system_prompt(MachineProfile())
    assert "never set a layer above 90 % power" in text
    assert "slow speed and full power" not in text


def test_every_tool_asks_for_a_note():
    from engraver.llm import TOOLS

    for tool in TOOLS:
        params = tool["function"]["parameters"]
        assert "note" in params["properties"] and "note" in params["required"], tool["function"]["name"]


def test_silent_reply_uses_the_notes():
    from engraver.llm import _describe

    text = _describe(
        [
            {"type": "replace_design", "note": "Redrew the outlines as 32 tokens"},
            {"type": "add_design", "note": "Engraved each piece on its token."},
            {"type": "set_layer", "note": "Engraved each piece on its token."},
        ]
    )
    assert text == "Redrew the outlines as 32 tokens. Engraved each piece on its token."


def test_context_carries_design_svgs_within_a_budget():
    import json

    from engraver.llm import MAX_SVG_CONTEXT, _context_text

    small = "<svg>" + "a" * 100 + "</svg>"
    big = "<svg>" + "b" * MAX_SVG_CONTEXT + "</svg>"
    text = _context_text({"designs": [{"id": "1", "svg": small}, {"id": "2", "svg": big}, {"id": "3"}]})
    designs = json.loads(text.split("\n", 1)[1])["designs"]
    assert designs[0]["svg"] == small
    assert "too large" in designs[1]["svg"]
    assert "svg" not in designs[2]


def test_prompt_explains_lining_parts_up():
    text = system_prompt(MachineProfile())
    assert "align_with" in text and "same viewBox" in text
