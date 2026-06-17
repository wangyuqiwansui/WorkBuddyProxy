function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

function stringifyArguments(value) {
  if (typeof value === "string") return value;
  if (value == null) return "{}";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeFunctionTool(tool) {
  if (!isObject(tool)) return null;
  const source = isObject(tool.function) ? tool.function : tool;
  const name = String(source.name || "").trim();
  if (tool.type !== "function" && !isObject(tool.function)) return null;
  if (!name) return null;

  return compactObject({
    type: "function",
    name,
    description: source.description,
    parameters: source.parameters || { type: "object", properties: {} },
    strict: typeof source.strict === "boolean" ? source.strict : undefined,
  });
}

function payloadTools(payload) {
  if (!isObject(payload)) return [];
  if (Array.isArray(payload.tools)) return payload.tools;
  if (Array.isArray(payload.extra_body?.tools)) return payload.extra_body.tools;
  if (Array.isArray(payload.extraBody?.tools)) return payload.extraBody.tools;
  if (Array.isArray(payload.functions)) {
    return payload.functions.map((item) => ({ type: "function", function: item }));
  }
  return [];
}

function forcedFunctionChoice(choice) {
  if (!isObject(choice)) return null;
  const name = String(choice.function?.name || choice.name || "").trim();
  if (!name) return null;
  return { type: "function", name };
}

function normalizeToolChoice(payload, hasTools) {
  if (!hasTools) return "none";
  const choice =
    payload?.tool_choice ??
    payload?.toolChoice ??
    payload?.extra_body?.tool_choice ??
    payload?.extraBody?.tool_choice ??
    payload?.function_call;

  if (choice == null || choice === "") return "auto";
  if (typeof choice === "string") return choice;
  return forcedFunctionChoice(choice) || choice;
}

function codexToolOptionsFromPayload(payload = {}) {
  const tools = payloadTools(payload).map(normalizeFunctionTool).filter(Boolean);
  const hasTools = tools.length > 0;
  const parallelToolCalls =
    typeof payload.parallel_tool_calls === "boolean"
      ? payload.parallel_tool_calls
      : typeof payload.parallelToolCalls === "boolean"
        ? payload.parallelToolCalls
        : hasTools;

  return {
    hasTools,
    tools,
    tool_choice: normalizeToolChoice(payload, hasTools),
    parallel_tool_calls: parallelToolCalls,
  };
}

function responseToolCallFromItem(item, index, idFactory) {
  if (!isObject(item) || item.type !== "function_call") return null;
  const name = String(item.name || item.function?.name || "").trim();
  if (!name) return null;
  const id = String(item.call_id || item.id || idFactory?.(index) || `call_${index}`);
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: stringifyArguments(item.arguments ?? item.function?.arguments),
    },
  };
}

function responseToolCallsFromResponse(response, idFactory) {
  const calls = [];
  for (const item of response?.output || []) {
    const call = responseToolCallFromItem(item, calls.length, idFactory);
    if (call) calls.push(call);
  }
  return calls;
}

function chatCompletionFromCodexResult(result, idFactory = () => "") {
  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  const message = toolCalls.length
    ? { role: "assistant", content: null, tool_calls: toolCalls }
    : { role: "assistant", content: result.text || "" };

  return {
    id: idFactory() || "",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
  };
}

function responsesFromCodexResult(result, idFactory = () => "") {
  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  const output = toolCalls.length
    ? toolCalls.map((call) => ({
      type: "function_call",
      id: call.id,
      call_id: call.id,
      name: call.function?.name || "",
      arguments: stringifyArguments(call.function?.arguments),
    }))
    : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: result.text || "" }] }];

  return {
    id: idFactory() || "",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: result.model,
    output_text: toolCalls.length ? "" : result.text || "",
    output,
  };
}

module.exports = {
  chatCompletionFromCodexResult,
  codexToolOptionsFromPayload,
  responseToolCallsFromResponse,
  responsesFromCodexResult,
};
