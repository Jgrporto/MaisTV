import { normalizeFlowMatchInput } from "./flow-store.js";

const TRUE_LABELS = new Set(["true", "sim", "yes", "y", "1", "success"]);
const FALSE_LABELS = new Set(["false", "nao", "não", "no", "n", "0", "fail"]);
const VALID_SECTORS = new Set(["suporte", "comercial", "financeiro", "retencao"]);
const VALID_PRIORITIES = new Set(["low", "medium", "high"]);

const asObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const asArray = (value) => (Array.isArray(value) ? value : []);

const getBuilderVariables = (flow) =>
  flow?.builderState?.variaveis && typeof flow.builderState.variaveis === "object"
    ? flow.builderState.variaveis
    : {};

const buildRuntimeVariables = (flow, context = {}) => {
  const variables = {};
  const builderVariables = getBuilderVariables(flow);
  for (const [id, definition] of Object.entries(builderVariables)) {
    const safeDefinition = asObject(definition);
    const initialValue = String(safeDefinition.value || "");
    const name = String(safeDefinition.name || "").trim();
    if (initialValue) {
      variables[String(id)] = initialValue;
      if (name) variables[name.trim().toLowerCase()] = initialValue;
    }
  }
  if (context.variables && typeof context.variables === "object") {
    for (const [key, value] of Object.entries(context.variables)) {
      variables[String(key).trim().toLowerCase()] = String(value || "");
    }
  }
  return variables;
};

const setRuntimeVariable = (flow, variables, variableId, value) => {
  const normalizedId = String(variableId || "").trim();
  if (!normalizedId) return;
  const normalizedValue = String(value || "");
  variables[normalizedId] = normalizedValue;
  const builderDefinition = asObject(getBuilderVariables(flow)[normalizedId]);
  const variableName = String(builderDefinition.name || "").trim().toLowerCase();
  if (variableName) {
    variables[variableName] = normalizedValue;
  }
};

const replaceVariables = (value, context, variables = {}) =>
  String(value || "")
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, token) => {
      const key = String(token || "").trim().toLowerCase();
      if (key === "nome") return String(context?.contactName || context?.name || "");
      if (key === "telefone" || key === "numero") return String(context?.waId || "");
      if (key === "mensagem" || key === "message") return String(context?.incomingText || "");
      return String(variables[key] || "");
    })
    .replace(/\{#([^}]+)\}/g, (_, token) => {
      const key = String(token || "").trim().toLowerCase();
      if (key === "nome") return String(context?.contactName || context?.name || "");
      if (key === "telefone" || key === "numero") return String(context?.waId || "");
      if (key === "mensagem" || key === "message") return String(context?.incomingText || "");
      return String(variables[key] || "");
    });

const buildConnectionsMap = (connections = []) => {
  const map = new Map();
  for (const connection of asArray(connections)) {
    const from = String(connection?.from || "").trim();
    if (!from) continue;
    const current = map.get(from) || [];
    current.push(connection);
    map.set(from, current);
  }
  return map;
};

const getConnectionData = (connection) =>
  connection?.data && typeof connection.data === "object" ? connection.data : {};

const normalizeBranchLabel = (value) => normalizeFlowMatchInput(value).replace(/\s+/g, "");

const pickBranchConnection = (connections, conditionResult) => {
  if (!Array.isArray(connections) || !connections.length) return null;
  const normalizedConnections = connections.map((connection) => ({
    ...connection,
    normalizedLabel: normalizeBranchLabel(connection?.label),
  }));
  const labelSet = conditionResult ? TRUE_LABELS : FALSE_LABELS;
  const labeled = normalizedConnections.find((connection) => labelSet.has(connection.normalizedLabel));
  if (labeled) return labeled;
  if (normalizedConnections.length > 1) {
    return conditionResult ? normalizedConnections[0] : normalizedConnections[1];
  }
  return normalizedConnections[0];
};

const parseTimeWindow = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const rangeMatch = raw.match(/^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);
  if (rangeMatch) {
    return { type: "range", start: rangeMatch[1], end: rangeMatch[2] };
  }
  const compareMatch = raw.match(/^(>=|<=|>|<)\s*(\d{2}:\d{2})$/);
  if (compareMatch) {
    return { type: "compare", operator: compareMatch[1], value: compareMatch[2] };
  }
  if (/^\d{2}:\d{2}$/.test(raw)) {
    return { type: "equals", value: raw };
  }
  return null;
};

const toMinutes = (value) => {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

const evaluateTimeCondition = (value, now = new Date()) => {
  const parsed = parseTimeWindow(value);
  if (!parsed) return false;
  const current = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const currentMinutes = toMinutes(current);
  if (currentMinutes == null) return false;
  if (parsed.type === "equals") return current === parsed.value;
  if (parsed.type === "range") {
    const start = toMinutes(parsed.start);
    const end = toMinutes(parsed.end);
    if (start == null || end == null) return false;
    return currentMinutes >= start && currentMinutes <= end;
  }
  const target = toMinutes(parsed.value);
  if (target == null) return false;
  if (parsed.operator === ">") return currentMinutes > target;
  if (parsed.operator === ">=") return currentMinutes >= target;
  if (parsed.operator === "<") return currentMinutes < target;
  if (parsed.operator === "<=") return currentMinutes <= target;
  return false;
};

const evaluateConditionNode = (node, context) => {
  const config = asObject(node?.config);
  const conditionType = String(config.condition_type || "client_exists").trim().toLowerCase();
  const expected = String(config.value || "").trim().toLowerCase();
  if (conditionType === "client_exists") {
    const expectedValue = expected ? expected === "true" || expected === "sim" || expected === "1" : true;
    return Boolean(context?.existsInBase) === expectedValue;
  }
  if (conditionType === "status_check") {
    return String(context?.status || "").trim().toLowerCase() === expected;
  }
  if (conditionType === "time_check") {
    return evaluateTimeCondition(config.value, context?.now);
  }
  return false;
};

const normalizeComparisonValue = (value) => normalizeFlowMatchInput(String(value || ""));

const compareSimpleDecision = (rawVariableValue, operator, expectedValue) => {
  const left = normalizeComparisonValue(rawVariableValue);
  const right = normalizeComparisonValue(expectedValue);
  const leftNumber = Number(rawVariableValue);
  const rightNumber = Number(expectedValue);
  switch (Number(operator || 1)) {
    case 1:
      return right ? left.includes(right) : Boolean(left);
    case 2:
      return left !== right;
    case 3:
      return right.split(",").map((item) => item.trim()).includes(left);
    case 4:
      return left === right;
    case 5:
      return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) ? leftNumber >= rightNumber : left >= right;
    case 6:
      return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) ? leftNumber > rightNumber : left > right;
    case 7:
      return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) ? leftNumber <= rightNumber : left <= right;
    case 8:
      return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) ? leftNumber < rightNumber : left < right;
    case 9:
      return !right.split(",").map((item) => item.trim()).includes(left);
    default:
      return false;
  }
};

const parseLegacyDecisionLabel = (connection) => {
  const rawLabel = String(connection?.label || connection?.value || "").trim();
  if (!rawLabel) return { variable: "", value: "", operator: 4 };
  const defaultMatch = rawLabel.match(/^padr[aã]o$/i);
  if (defaultMatch) return { variable: "", value: "", operator: 4 };
  const arrowMatch = rawLabel.match(/^\s*([^=><!→-][^→=><!]*)\s*(?:→|->|=>)\s*(.+?)\s*$/);
  if (!arrowMatch) return { variable: "", value: "", operator: 4 };
  return {
    variable: String(arrowMatch[1] || "").trim(),
    value: String(arrowMatch[2] || "").trim(),
    operator: 4,
  };
};

const isLegacyBlankDecisionDefault = (connection) => {
  const data = getConnectionData(connection);
  const cnt = asObject(data.cnt);
  const opt = asObject(data.opt);
  const rawLabel = String(connection?.label || connection?.value || "").trim();
  return (
    !rawLabel &&
    !String(cnt.type || "").trim() &&
    !String(opt.variable || "").trim() &&
    !String(opt.value || "").trim() &&
    !String(opt.field_compare || "").trim()
  );
};

const pickDecisionConnection = (connections, context, variables) => {
  if (!Array.isArray(connections) || !connections.length) return null;
  const incomingMessage = normalizeComparisonValue(context?.incomingText || "");
  const defaultConnection = connections.find((connection) => {
    return getConnectionType(connection) === "default" || isLegacyBlankDecisionDefault(connection);
  });

  for (const connection of connections) {
    const data = getConnectionData(connection);
    const cnt = asObject(data.cnt);
    const opt = asObject(data.opt);
    const legacyDecision = parseLegacyDecisionLabel(connection);
    const explicitType = String(cnt.type || "").toLowerCase().trim();
    const connectionType =
      explicitType || (legacyDecision.variable || legacyDecision.value ? "option" : "");
    if (connectionType !== "option") continue;

    if (Number(opt.type || 1) === 2) {
      const fieldCompare = normalizeComparisonValue(
        replaceVariables(String(opt.field_compare || ""), context, variables),
      );
      if (fieldCompare && incomingMessage && fieldCompare.includes(incomingMessage)) {
        return connection;
      }
      continue;
    }

    const variableId = String(opt.variable || legacyDecision.variable || "").trim();
    const operator = Number(opt.operator || legacyDecision.operator || 4);
    const expectedValue = replaceVariables(opt.value || legacyDecision.value || "", context, variables);
    const rawVariableValue = variableId
      ? variables[variableId] || variables[variableId.toLowerCase()] || ""
      : context?.incomingText || "";
    if (compareSimpleDecision(rawVariableValue, operator, expectedValue)) {
      return connection;
    }
  }

  return defaultConnection || null;
};

const pickUraConnection = (connections, context) => {
  if (!Array.isArray(connections) || !connections.length) return null;
  const incomingMessage = normalizeComparisonValue(context?.incomingText || "");
  if (!incomingMessage) {
    return (
      connections.find((connection) => {
        return getConnectionType(connection) === "timeout";
      }) || null
    );
  }

  for (const connection of connections) {
    const data = getConnectionData(connection);
    const legacy = parseLegacyConnectionLabel(connection);
    const opt = asObject(data.opt);
    if (getConnectionType(connection) !== "option") continue;
    const optionNumber = normalizeComparisonValue(opt.number_option || legacy.number || "");
    const description = normalizeComparisonValue(opt.description || legacy.description || "");
    const extraDescription = normalizeComparisonValue(opt.extraDescription || "");
    const synonyms = asArray(opt.synonym).map((item) => normalizeComparisonValue(item));
    if (
      incomingMessage === optionNumber ||
      (description && incomingMessage.includes(description)) ||
      (extraDescription && incomingMessage.includes(extraDescription)) ||
      synonyms.includes(incomingMessage)
    ) {
      return connection;
    }
  }

  return (
    connections.find((connection) => {
      return getConnectionType(connection) === "invalid";
    }) || null
  );
};

const isValidCollectInput = (validationCode, input) => {
  const value = String(input || "").trim();
  switch (Number(validationCode || 0)) {
    case 0:
      return Boolean(value);
    case 1:
    case 7:
      return /^\d{10,13}$/.test(value.replace(/\D/g, ""));
    case 2:
      return /^\d{2}\/\d{2}\/\d{4}$/.test(value) || /^\d{4}-\d{2}-\d{2}$/.test(value);
    case 3:
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 4:
      return /^[A-Za-zÀ-ÿ\s]{2,}$/.test(value);
    case 5:
      return /^-?\d+([.,]\d+)?$/.test(value);
    default:
      return Boolean(value);
  }
};

const findValidationConnection = (connections, validationCondition) =>
  asArray(connections).find(
    (connection) => Number(getConnectionData(connection).validation_condition || 0) === Number(validationCondition),
  ) || null;

const parseLegacyConnectionLabel = (connection) => {
  const rawLabel = String(connection?.label || connection?.value || "").trim();
  if (!rawLabel) return { type: "", number: "", description: "" };

  const normalized = rawLabel.toLowerCase();
  if (normalized.includes("inválido") || normalized.includes("invalido")) {
    return { type: "invalid", number: "", description: rawLabel };
  }
  if (normalized.includes("tempo de espera")) {
    return { type: "timeout", number: "", description: rawLabel };
  }
  if (normalized.includes("padrão") || normalized.includes("padrao")) {
    return { type: "default", number: "", description: rawLabel };
  }

  const optionMatch = rawLabel.match(/^\s*(\d+)\s*-\s*(.+)\s*$/);
  if (optionMatch) {
    return {
      type: "option",
      number: String(optionMatch[1] || "").trim(),
      description: String(optionMatch[2] || "").trim(),
    };
  }

  return { type: "option", number: "", description: rawLabel };
};

const getConnectionType = (connection) => {
  const cnt = asObject(getConnectionData(connection).cnt);
  const explicitType = String(cnt.type || "").trim().toLowerCase();
  if (explicitType) return explicitType;
  return parseLegacyConnectionLabel(connection).type;
};

const buildUraOutput = (node, context, variables, connections) => {
  const config = asObject(node?.config);
  const body = replaceVariables(config.message || "", context, variables).trim();
  const headerEnabled = Boolean(config.header_enabled);
  const headerType = String(config.header_type || "image").trim().toLowerCase();
  const headerAsset = replaceVariables(config.header_asset || "", context, variables).trim();
  const optionConnections = asArray(connections).filter((connection) => {
    return getConnectionType(connection) === "option";
  });
  const options = optionConnections
    .map((connection, index) => {
      const opt = asObject(getConnectionData(connection).opt);
      const legacy = parseLegacyConnectionLabel(connection);
      const number = String(opt.number_option || "").trim();
      const rawDescription = replaceVariables(opt.description || "", context, variables).trim();
      const fallbackDescription = String(connection?.value || "")
        .replace(/^\s*\d+\s*-\s*/g, "")
        .trim();
      const description = rawDescription || fallbackDescription || legacy.description;
      if (!description) return null;
      const safeNumber = number || legacy.number || String(index + 1);
      return {
        id: `ura:${node.id}:${safeNumber}`,
        number: safeNumber,
        title: description.slice(0, 20),
        description: String(opt.extraDescription || "").trim().slice(0, 72),
        label: `${safeNumber} - ${description}`,
      };
    })
    .filter(Boolean);

  if (Number(config.bol_botoes_ura || 0) === 1 && options.length > 0) {
    return {
      type: "interactive_buttons",
      text: body,
      header: headerEnabled && headerAsset ? { type: headerType, asset: headerAsset } : null,
      buttons: options.slice(0, 3).map((option) => ({
        id: option.id,
        title: option.title,
      })),
    };
  }

  if (Number(config.bol_botoes_ura || 0) === 2 && options.length > 0) {
    return {
      type: "interactive_list",
      text: body,
      buttonText: String(config.list_button_text || "MENU").trim() || "MENU",
      rows: options.map((option) => ({
        id: option.id,
        title: option.label.slice(0, 24),
        description: option.description,
      })),
    };
  }

  const enumerated = options.map((option) => option.label).join("\n");
  return {
    type: "text",
    text: [body, enumerated].filter(Boolean).join("\n\n").trim(),
  };
};

const interleaveDelayOutputs = (outputs, delaySeconds, { appendTrailingDelay = false } = {}) => {
  if (!Array.isArray(outputs) || outputs.length === 0 || delaySeconds <= 0) {
    return Array.isArray(outputs) ? outputs.filter(Boolean) : [];
  }
  const nextOutputs = [];
  outputs.forEach((output, index) => {
    if (!output) return;
    nextOutputs.push(output);
    const isLast = index === outputs.length - 1;
    if (!isLast || appendTrailingDelay) {
      nextOutputs.push({ type: "delay", seconds: delaySeconds });
    }
  });
  return nextOutputs;
};

const buildMessageOutputs = (node, context, variables) => {
  const config = asObject(node?.config);
  const configuredMessages = asArray(config.messages)
    .map((item) => replaceVariables(item || "", context, variables).trim())
    .filter(Boolean);
  const fallbackMessage = replaceVariables(config.message || "", context, variables).trim();
  const textMessages = configuredMessages.length
    ? configuredMessages
    : fallbackMessage
      ? [fallbackMessage]
      : [];
  const headerEnabled = Boolean(config.header_enabled);
  const headerType = String(config.header_type || "image").trim().toLowerCase();
  const headerAsset = replaceVariables(config.header_asset || "", context, variables).trim();
  const delaySeconds = Math.max(0, Number(config.num_delay || 0));
  const outputs = [];

  if (headerEnabled && headerAsset && ["image", "video", "document"].includes(headerType)) {
    outputs.push({
      type: "media",
      mediaType: headerType,
      asset: headerAsset,
      caption: textMessages[0] || "",
    });
    textMessages.slice(1).forEach((text) => {
      outputs.push({ type: "text", text });
    });
    return interleaveDelayOutputs(outputs, delaySeconds, { appendTrailingDelay: true });
  }

  textMessages.forEach((text) => {
    outputs.push({ type: "text", text });
  });
  return interleaveDelayOutputs(outputs, delaySeconds, { appendTrailingDelay: true });
};

export const buildFlowExecutionPlan = (flow, context = {}) => {
  if (!flow || typeof flow !== "object") return null;
  const nodes = asArray(flow.nodes);
  const connections = asArray(flow.connections);
  const nodeById = new Map(nodes.map((node) => [String(node.id), node]));
  const connectionsByFrom = buildConnectionsMap(connections);
  const incomingIds = new Set(connections.map((connection) => String(connection?.to || "").trim()).filter(Boolean));
  const trace = [];
  const outputs = [];
  const messages = [];
  const labelsToAdd = new Set();
  const labelsToRemove = new Set();
  const patch = {};
  const variables = buildRuntimeVariables(flow, context);
  const startNodeId = context?.startNodeId ? String(context.startNodeId).trim() : "";
  const resumeAtCurrentNode = Boolean(context?.resumeAtCurrentNode);

  let currentNode =
    (startNodeId ? nodeById.get(startNodeId) : null) ||
    nodes.find((node) => !incomingIds.has(String(node.id))) ||
    nodes.find((node) => String(node?.type || "").toLowerCase() === "trigger") ||
    null;
  let safety = 0;
  let pause = null;
  let redirect = null;

  while (currentNode && safety < 60) {
    safety += 1;
    trace.push({
      nodeId: String(currentNode.id),
      type: String(currentNode.type || ""),
      label: String(currentNode.label || ""),
    });

    const config = asObject(currentNode?.config);
    const type = String(currentNode.type || "").toLowerCase();
    const currentConnections = connectionsByFrom.get(String(currentNode.id)) || [];
    let nextConnection = null;

    if (type === "message" || type === "action") {
      const actionType = String(config.action_type || "send_message").trim().toLowerCase();
      if (type === "message" || actionType === "send_message") {
        const nodeOutputs =
          type === "message"
            ? buildMessageOutputs(currentNode, context, variables)
            : (() => {
                const text = replaceVariables(config.message || "", context, variables).trim();
                if (!text) return [];
                return [{ type: "text", text }];
              })();
        nodeOutputs.forEach((output) => {
          if (!output) return;
          outputs.push(output);
          if (output.type === "text") {
            messages.push(output.text);
          } else if (output.type === "media" && output.caption) {
            messages.push(output.caption);
          }
        });
      } else if (actionType === "send_button") {
        const text = replaceVariables(config.message || config.button_text || "", context, variables).trim();
        if (text) {
          outputs.push({ type: "text", text });
          messages.push(text);
        }
      } else if (actionType === "transfer_sector") {
        const sector = String(config.sector || "").trim().toLowerCase();
        if (VALID_SECTORS.has(sector)) patch.sector = sector;
      } else if (actionType === "add_tag") {
        const label = replaceVariables(config.tag || "", context, variables).trim();
        if (label) {
          labelsToAdd.add(label);
          labelsToRemove.delete(label);
        }
      } else if (actionType === "set_priority") {
        const priority = String(config.priority || "").trim().toLowerCase();
        if (VALID_PRIORITIES.has(priority)) patch.priority = priority;
      }
      nextConnection = currentConnections[0] || null;
    } else if (type === "collect_input") {
      if (!resumeAtCurrentNode || startNodeId !== String(currentNode.id)) {
        pause = {
          type: "collect_input",
          nodeId: String(currentNode.id),
          timeoutSeconds: Number(config.timeout || 20),
          variableId: String(config.variable || ""),
        };
        break;
      }

      const inputValue = String(context?.incomingText || "").trim();
      const valid = isValidCollectInput(config.validation, inputValue);
      trace.push({ nodeId: String(currentNode.id), type: "collect_result", label: valid ? "valid" : "invalid" });
      if (valid && config.variable) {
        setRuntimeVariable(flow, variables, config.variable, inputValue);
      }
      nextConnection =
        findValidationConnection(currentConnections, valid ? 1 : 2) ||
        currentConnections[0] ||
        null;
    } else if (type === "tag") {
      for (const label of asArray(config.tags)) {
        const normalized = replaceVariables(label, context, variables).trim();
        if (normalized) {
          labelsToAdd.add(normalized);
          labelsToRemove.delete(normalized);
        }
      }
      for (const label of asArray(config.tagsExcluir)) {
        const normalized = replaceVariables(label, context, variables).trim();
        if (normalized) {
          labelsToRemove.add(normalized);
          labelsToAdd.delete(normalized);
        }
      }
      nextConnection = currentConnections[0] || null;
    } else if (type === "condition") {
      const result = evaluateConditionNode(currentNode, context);
      trace.push({ nodeId: String(currentNode.id), type: "condition_result", label: String(result) });
      nextConnection = pickBranchConnection(currentConnections, result);
    } else if (type === "decision") {
      nextConnection = pickDecisionConnection(currentConnections, context, variables);
    } else if (type === "ura") {
      if (!resumeAtCurrentNode || startNodeId !== String(currentNode.id)) {
        const output = buildUraOutput(currentNode, context, variables, currentConnections);
        if (output?.text) messages.push(output.text);
        if (output) outputs.push(output);
        pause = {
          type: "ura",
          nodeId: String(currentNode.id),
          timeoutSeconds: Number(config.timeout || 20),
        };
        break;
      }

      nextConnection = pickUraConnection(currentConnections, context);
      trace.push({ nodeId: String(currentNode.id), type: "ura_result", label: nextConnection ? String(nextConnection.value || "selected") : "invalid" });
    } else if (type === "wait") {
      const timeoutSeconds = Math.max(0, Number(config.timeout || 0));
      if (timeoutSeconds > 0) {
        outputs.push({ type: "delay", seconds: timeoutSeconds });
      }
      nextConnection = currentConnections[0] || null;
    } else if (type === "set_variables") {
      const variableIds = asArray(config.variables);
      const values = asArray(config.values);
      variableIds.forEach((variableId, index) => {
        setRuntimeVariable(flow, variables, variableId, replaceVariables(values[index] || "", context, variables).trim());
      });
      nextConnection = currentConnections[0] || null;
    } else if (type === "redirect") {
      const variableIds = asArray(config.variables);
      const values = asArray(config.values);
      variableIds.forEach((variableId, index) => {
        if (!String(variableId || "").trim()) return;
        setRuntimeVariable(
          flow,
          variables,
          variableId,
          replaceVariables(values[index] || "", context, variables).trim(),
        );
      });
      const redirectTargetId = String(config.component || "").trim();
      const redirectTargetIdentifier = String(config.component_identifier || "").trim().toLowerCase();
      const resolvedRedirectTargetId =
        redirectTargetId ||
        (redirectTargetIdentifier
          ? nodes.find((node) => {
              const nodeConfig = asObject(node?.config);
              return String(nodeConfig.identifier || node?.label || "")
                .trim()
                .toLowerCase() === redirectTargetIdentifier;
            })?.id || ""
          : "");
      if (Number(config.type || 1) === 1 && resolvedRedirectTargetId) {
        nextConnection = { to: String(resolvedRedirectTargetId) };
      } else {
        redirect = {
          flowRef: String(config.flow || "").trim(),
          componentId: String(config.component || "").trim(),
          componentIdentifier: String(config.component_identifier || "").trim(),
        };
        trace.push({
          nodeId: String(currentNode.id),
          type: "redirect_flow",
          label:
            redirect.flowRef ||
            redirect.componentIdentifier ||
            redirect.componentId ||
            "redirect_flow",
        });
        break;
      }
    } else if (type === "code") {
      trace.push({ nodeId: String(currentNode.id), type: "code_skipped", label: "runtime_disabled" });
      nextConnection = currentConnections[0] || null;
    } else if (type === "end") {
      const text = replaceVariables(config.message || "", context, variables).trim();
      if (text) {
        outputs.push({ type: "text", text });
        messages.push(text);
      }
      break;
    } else {
      nextConnection = currentConnections[0] || null;
    }

    if (!nextConnection) break;
    currentNode = nodeById.get(String(nextConnection.to)) || null;
  }

  return {
    outputs,
    messages,
    labelsToAdd: [...labelsToAdd],
    labelsToRemove: [...labelsToRemove],
    patch,
    trace,
    pause,
    redirect,
    variables,
  };
};
