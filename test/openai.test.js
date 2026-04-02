"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildChatCompletionChunk,
  buildChatCompletionResponse,
  buildOpenAiModelsResponse,
  buildResponsesApiResponse,
  convertResponsesInputToOpenAiMessages,
  flattenOpenAiRequest
} = require("../src/openai");

test("flattenOpenAiRequest includes tools and tool calls", () => {
  const flattened = flattenOpenAiRequest({
    tools: [
      {
        type: "function",
        function: {
          name: "lookup_weather",
          description: "Look up weather",
          parameters: { type: "object" }
        }
      }
    ],
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            function: { name: "lookup_weather", arguments: "{\"city\":\"Hangzhou\"}" }
          }
        ]
      }
    ]
  });

  assert.match(flattened, /Available tools:/);
  assert.match(flattened, /Assistant requested tool lookup_weather id=call_1/);
});

test("buildChatCompletionResponse maps tool calls", () => {
  const response = buildChatCompletionResponse(
    { model: "accio-bridge" },
    "",
    {
      inputTokens: 11,
      outputTokens: 7,
      toolCalls: [{ id: "call_1", name: "lookup_weather", input: { city: "Hangzhou" } }]
    }
  );

  assert.equal(response.choices[0].finish_reason, "tool_calls");
  assert.equal(response.choices[0].message.tool_calls[0].function.name, "lookup_weather");
});

test("buildChatCompletionChunk and model listing stay OpenAI-compatible", async () => {
  const chunk = buildChatCompletionChunk(
    { model: "accio-bridge" },
    { role: "assistant", content: "OK" },
    { finishReason: null }
  );
  const models = await buildOpenAiModelsResponse();

  assert.equal(chunk.object, "chat.completion.chunk");
  assert.equal(models.object, "list");
  assert.equal(models.data[0].id, "accio-bridge");
});


test("convertResponsesInputToOpenAiMessages maps text and image inputs", () => {
  const messages = convertResponsesInputToOpenAiMessages({
    instructions: "be concise",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "describe this" },
          { type: "input_image", image_url: "https://example.com/a.png" }
        ]
      }
    ]
  });

  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].content[0].type, "text");
  assert.equal(messages[1].content[1].type, "image_url");
});

test("buildResponsesApiResponse emits message and tool items separately", () => {
  const response = buildResponsesApiResponse(
    { model: "claude-opus-4-6" },
    "done",
    {
      messageId: "msg_1",
      toolCalls: [{ id: "call_1", name: "lookup_weather", input: { city: "Hangzhou" } }]
    }
  );

  assert.equal(response.output.length, 2);
  assert.equal(response.output[0].type, "message");
  assert.equal(response.output[0].content[0].type, "output_text");
  assert.equal(response.output[1].type, "tool_call");
  assert.equal(response.output[1].name, "lookup_weather");
});
