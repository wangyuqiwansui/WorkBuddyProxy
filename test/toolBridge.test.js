const assert = require("node:assert/strict");
const test = require("node:test");

const {
  chatCompletionFromCodexResult,
  codexToolOptionsFromPayload,
  responsesFromCodexResult,
} = require("../lib/toolBridge");

test("codexToolOptionsFromPayload converts chat completion tools to Responses function tools", () => {
  const options = codexToolOptionsFromPayload({
    tools: [
      {
        type: "function",
        function: {
          name: "search_docs",
          description: "Search internal docs",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
    ],
  });

  assert.equal(options.hasTools, true);
  assert.equal(options.tool_choice, "auto");
  assert.deepEqual(options.tools, [
    {
      type: "function",
      name: "search_docs",
      description: "Search internal docs",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ]);
});

test("codexToolOptionsFromPayload converts forced chat tool choice to Responses shape", () => {
  const options = codexToolOptionsFromPayload({
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    tool_choice: {
      type: "function",
      function: { name: "get_weather" },
    },
  });

  assert.deepEqual(options.tool_choice, { type: "function", name: "get_weather" });
});

test("chatCompletionFromCodexResult returns OpenAI-compatible tool calls", () => {
  const result = {
    model: "gpt-5.5",
    text: "",
    toolCalls: [
      {
        id: "call_abc",
        type: "function",
        function: {
          name: "search_docs",
          arguments: "{\"query\":\"proxy tools\"}",
        },
      },
    ],
  };

  const completion = chatCompletionFromCodexResult(result, () => "chatcmpl-test");

  assert.equal(completion.choices[0].finish_reason, "tool_calls");
  assert.equal(completion.choices[0].message.content, null);
  assert.deepEqual(completion.choices[0].message.tool_calls, result.toolCalls);
});

test("responsesFromCodexResult returns function_call output items", () => {
  const response = responsesFromCodexResult(
    {
      model: "gpt-5.5",
      text: "",
      toolCalls: [
        {
          id: "call_weather",
          type: "function",
          function: {
            name: "get_weather",
            arguments: "{\"location\":\"Paris\"}",
          },
        },
      ],
    },
    () => "resp_test",
  );

  assert.equal(response.output_text, "");
  assert.deepEqual(response.output, [
    {
      type: "function_call",
      id: "call_weather",
      call_id: "call_weather",
      name: "get_weather",
      arguments: "{\"location\":\"Paris\"}",
    },
  ]);
});
