"""
Agent Guardian - Minimal Agent Loop
A small ReAct-style loop using native tool-calling. Built from scratch,
no agent framework, so every tool call is guaranteed to pass through
our instrumentation/policy layer (tools.py) with nothing bypassing it.

Two backends supported, pick with LLM_BACKEND env var:
  - "anthropic" (default) -> requires ANTHROPIC_API_KEY
  - "groq"                -> requires GROQ_API_KEY
    Groq is OpenAI-shaped (same SDK, base_url swapped) and is a good
    choice for a live hackathon demo since it's very fast, minimizing
    dead air between tool calls on stage.
"""

import os
import json

from tools import TOOL_REGISTRY
from tools import PolicyBlocked, PolicyPendingConfirm

BACKEND = os.environ.get("LLM_BACKEND", "anthropic")

TOOLS_SCHEMA_ANTHROPIC = [
    {
        "name": "read_file",
        "description": "Read the contents of a local file.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Write content to a local file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "run_shell",
        "description": "Run a shell command and return its output.",
        "input_schema": {
            "type": "object",
            "properties": {"cmd": {"type": "string"}},
            "required": ["cmd"],
        },
    },
    {
        "name": "call_api",
        "description": "Make an HTTP request to a URL.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "method": {"type": "string", "default": "GET"},
                "body": {"type": "string", "default": ""},
            },
            "required": ["url"],
        },
    },
]

# OpenAI/Groq function-calling shape wraps each tool under {"type":"function","function":{...}}
TOOLS_SCHEMA_OPENAI = [
    {"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}}
    for t in TOOLS_SCHEMA_ANTHROPIC
]


def run_agent(task: str, max_steps: int = 8, model: str = None):
    if BACKEND == "groq":
        return _run_agent_groq(task, max_steps, model or "llama-3.3-70b-versatile")
    return _run_agent_anthropic(task, max_steps, model or "claude-sonnet-4-6")


def _run_agent_groq(task: str, max_steps: int, model: str):
    from openai import OpenAI  # Groq is OpenAI-SDK-compatible

    client = OpenAI(
        api_key=os.environ.get("GROQ_API_KEY"),
        base_url="https://api.groq.com/openai/v1",
    )
    messages = [{"role": "user", "content": task}]
    print(f"\n=== Agent Guardian session start (groq/{model}) ===\nTask: {task}\n")

    for step in range(max_steps):
        response = client.chat.completions.create(
            model=model,
            max_tokens=1024,
            tools=TOOLS_SCHEMA_OPENAI,
            messages=messages,
        )
        msg = response.choices[0].message
        messages.append(msg.model_dump(exclude_none=True))

        if not msg.tool_calls:
            print("=== Agent finished ===\n" + (msg.content or ""))
            return msg.content

        for call in msg.tool_calls:
            tool_fn = TOOL_REGISTRY.get(call.function.name)
            args = json.loads(call.function.arguments)
            try:
                if not tool_fn:
                    raise ValueError(f"Unknown tool: {call.function.name}")
                result = tool_fn(**args)
                content = str(result)[:2000]
            except PolicyBlocked as e:
                print(f"[BLOCKED] {call.function.name} -> {e.reasons}")
                content = f"ACTION BLOCKED by security policy: {e.reasons}. Do not retry this action."
            except PolicyPendingConfirm as e:
                print(f"[NEEDS CONFIRMATION] {call.function.name} -> {e.reasons}")
                content = f"Action paused for user confirmation ({e.reasons}). Treat as denied for now."
            except Exception as e:
                content = f"Tool error: {e}"

            messages.append({"role": "tool", "tool_call_id": call.id, "content": content})

    print("=== Max steps reached ===")
    return None


def _run_agent_anthropic(task: str, max_steps: int, model: str):
    import anthropic

    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
    messages = [{"role": "user", "content": task}]
    print(f"\n=== Agent Guardian session start ===\nTask: {task}\n")

    for step in range(max_steps):
        response = client.messages.create(
            model=model,
            max_tokens=1024,
            tools=TOOLS_SCHEMA_ANTHROPIC,
            messages=messages,
        )

        messages.append({"role": "assistant", "content": response.content})

        tool_use_blocks = [b for b in response.content if b.type == "tool_use"]
        if not tool_use_blocks:
            # agent produced a final text answer
            text_blocks = [b.text for b in response.content if b.type == "text"]
            print("=== Agent finished ===\n" + "\n".join(text_blocks))
            return "\n".join(text_blocks)

        tool_results = []
        for block in tool_use_blocks:
            tool_fn = TOOL_REGISTRY.get(block.name)
            try:
                if not tool_fn:
                    raise ValueError(f"Unknown tool: {block.name}")
                result = tool_fn(**block.input)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": str(result)[:2000],
                })
            except PolicyBlocked as e:
                print(f"[BLOCKED] {block.name} -> {e.reasons}")
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": f"ACTION BLOCKED by security policy: {e.reasons}. Do not retry this action.",
                    "is_error": True,
                })
            except PolicyPendingConfirm as e:
                print(f"[NEEDS CONFIRMATION] {block.name} -> {e.reasons}")
                # Demo simplification: auto-deny. Wire this to a real UI
                # confirm dialog for the full build.
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": f"Action paused for user confirmation ({e.reasons}). Treat as denied for now.",
                    "is_error": True,
                })
            except Exception as e:
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": f"Tool error: {e}",
                    "is_error": True,
                })

        messages.append({"role": "user", "content": tool_results})

    print("=== Max steps reached ===")
    return None


if __name__ == "__main__":
    import sys
    task = sys.argv[1] if len(sys.argv) > 1 else "List the files in the current directory."
    run_agent(task)
