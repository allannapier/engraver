"""The assistant's system prompt keeps its power guardrails."""

from engraver.config import MachineProfile
from engraver.llm import system_prompt


def test_prompt_caps_power():
    text = system_prompt(MachineProfile())
    assert "never set a layer above 90 % power" in text
    assert "slow speed and full power" not in text
