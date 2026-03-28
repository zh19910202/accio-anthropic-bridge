"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { validateAnthropicMessages, validateOpenAiMessages } = require("../src/tooling");

test("validateAnthropicMessages accepts tool_use followed by tool_result", () => {
  const result = validateAnthropicMessages([
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tool_1", name: "lookup", input: { q: "weather" } }]
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool_1", content: "sunny" }]
    }
  ]);

  assert.equal(result.toolRequests[0].id, "tool_1");
  assert.equal(result.toolResults[0].toolUseId, "tool_1");
});

test("validateAnthropicMessages rejects tool_result without known tool_use_id", () => {
  assert.throws(
    () =>
      validateAnthropicMessages([
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "missing", content: "nope" }]
        }
      ]),
    (error) => error && error.status === 400
  );
});

test("validateOpenAiMessages rejects unknown tool_call_id", () => {
  assert.throws(
    () =>
      validateOpenAiMessages([
        { role: "user", content: "hello" },
        { role: "tool", tool_call_id: "call_missing", content: "nope" }
      ]),
    (error) => error && error.status === 400
  );
});
