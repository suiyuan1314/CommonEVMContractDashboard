import React, { useEffect, useMemo, useRef, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId, useWalletClient } from "wagmi";
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  isAddress,
  parseEther,
} from "viem";

const DEFAULTS = {
  rpcList: "https://api.explorer.wardenprotocol.org/api/eth-rpc",
  chainId: "8765",
  explorerBase: "https://explorer.wardenprotocol.org/",
  explorerApi: "https://api.explorer.wardenprotocol.org/api",
  explorerApiKey: "",
  contractAddress: "0xAB5159B5655CdAA5178C283853841aBB0D02Eef9",
  abi: "",
};

const TEMPLATE_STORAGE_KEY = "common-evm-dashboard.templates.v1";
const TEMPLATE_EXPORT_VERSION = 1;
const EXPONENT_OPTIONS = [0, 6, 9, 12, 18, 24];
const SCALE_TYPES = new Set(["uint256", "uint128"]);

function shortAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function parseRpcList(text) {
  return text
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseChainIdValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function formatValue(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(formatValue);
  }
  if (value && typeof value === "object") {
    const entries = {};
    Object.keys(value).forEach((key) => {
      if (Number.isNaN(Number(key))) {
        entries[key] = formatValue(value[key]);
      }
    });
    if (Object.keys(entries).length > 0) {
      return entries;
    }
  }
  return value;
}

function stringifyResult(result) {
  const formatted = formatValue(result);
  if (typeof formatted === "string") {
    return formatted;
  }
  return JSON.stringify(formatted, null, 2);
}

function parseInputValue(value, type) {
  const trimmed = value.trim();
  if (type.endsWith("]") || type.startsWith("tuple")) {
    if (!trimmed) return [];
    return JSON.parse(trimmed);
  }
  if (type === "bool") {
    return trimmed === "true" || trimmed === "1";
  }
  if (type.startsWith("uint") || type.startsWith("int")) {
    if (!trimmed) return 0n;
    return BigInt(trimmed);
  }
  return trimmed;
}

function parseDecimalWithExponent(value, exponent) {
  const trimmed = value.trim();
  if (!trimmed) return 0n;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("输入格式不正确，请输入数字。");
  }
  const [whole, fractionRaw = ""] = trimmed.split(".");
  if (fractionRaw.length > exponent) {
    throw new Error(`小数位过多，最多支持 ${exponent} 位。`);
  }
  const fraction = fractionRaw.padEnd(exponent, "0");
  return BigInt(`${whole}${fraction}`);
}

function getFunctionSignature(fn) {
  const types = (fn.inputs || []).map((input) => input.type).join(",");
  return `${fn.name}(${types})`;
}

function isReadFunction(fn) {
  return (
    fn.stateMutability === "view" ||
    fn.stateMutability === "pure" ||
    fn.constant === true
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryCall(fn, attempts = 3, delayMs = 400) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn(i);
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

function generateTemplateId() {
  return `tpl_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function getCurrentIsoTime() {
  return new Date().toISOString();
}

function buildMethodStorageKey(kind, fn) {
  return `${kind}:${getFunctionSignature(fn)}`;
}

function isExpandableTuple(param) {
  return (
    typeof param?.type === "string" &&
    param.type === "tuple" &&
    Array.isArray(param.components) &&
    param.components.length > 0
  );
}

function isTupleArrayParam(param) {
  return (
    typeof param?.type === "string" &&
    param.type === "tuple[]" &&
    Array.isArray(param.components) &&
    param.components.length > 0
  );
}

function buildParamNodes(params, path = [], useRelativePath = false) {
  return (params || []).map((param, index) => {
    const currentPath = useRelativePath ? [...path, index] : [...path, index];
    const key = currentPath.join(".");
    const name = param?.name || `arg${index}`;

    if (isTupleArrayParam(param)) {
      return {
        kind: "tupleArray",
        key,
        name,
        type: param.type,
        path: currentPath,
        children: buildParamNodes(param.components, [], true),
      };
    }

    if (isExpandableTuple(param)) {
      return {
        kind: "tuple",
        key,
        name,
        type: param.type,
        path: currentPath,
        children: buildParamNodes(param.components, currentPath, useRelativePath),
      };
    }

    return {
      kind: "leaf",
      key,
      name,
      type: param?.type || "unknown",
      path: currentPath,
      components: Array.isArray(param?.components) ? param.components : null,
    };
  });
}

function toInputString(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function getTupleChildValue(tupleValue, child, index) {
  if (Array.isArray(tupleValue)) {
    return tupleValue[index];
  }
  if (tupleValue && typeof tupleValue === "object") {
    if (child.name && Object.prototype.hasOwnProperty.call(tupleValue, child.name)) {
      return tupleValue[child.name];
    }
    return tupleValue[index];
  }
  return undefined;
}

function fillValuesFromNodes(nodes, tupleValue, targetValues) {
  nodes.forEach((child, index) => {
    const nextValue = getTupleChildValue(tupleValue, child, index);
    if (nextValue === undefined || nextValue === null) return;

    if (child.kind === "leaf") {
      targetValues[child.key] = toInputString(nextValue);
      return;
    }

    if (child.kind === "tuple") {
      fillValuesFromNodes(child.children, nextValue, targetValues);
    }
  });
}

function fillValuesFromTupleNode(node, tupleValue, targetValues) {
  if (!node || node.kind !== "tuple") return;
  fillValuesFromNodes(node.children, tupleValue, targetValues);
}

function applyLeafDefaults(nodes, values, exponents) {
  nodes.forEach((node) => {
    if (node.kind === "leaf") {
      if (values[node.key] === undefined) {
        values[node.key] = "";
      }
      if (SCALE_TYPES.has(node.type)) {
        const exponent = Number(exponents[node.key] || 0);
        exponents[node.key] = Number.isNaN(exponent) ? 0 : exponent;
      }
      return;
    }

    if (node.kind === "tupleArray") {
      return;
    }

    applyLeafDefaults(node.children, values, exponents);
  });
}

function sanitizeTupleArrayRow(rawRow) {
  const safeRow =
    rawRow && typeof rawRow === "object" && !Array.isArray(rawRow) ? rawRow : {};

  const values = {};
  const rawValues =
    safeRow.values && typeof safeRow.values === "object" && !Array.isArray(safeRow.values)
      ? safeRow.values
      : safeRow;
  Object.entries(rawValues).forEach(([key, value]) => {
    if (key === "values" || key === "exponents") return;
    values[key] = String(value ?? "");
  });

  const exponents = {};
  if (safeRow.exponents && typeof safeRow.exponents === "object") {
    Object.entries(safeRow.exponents).forEach(([key, value]) => {
      const parsed = Number(value || 0);
      exponents[key] = Number.isNaN(parsed) ? 0 : parsed;
    });
  }

  return { values, exponents };
}

function sanitizeTupleArrayMap(rawTupleArrays) {
  if (
    !rawTupleArrays ||
    typeof rawTupleArrays !== "object" ||
    Array.isArray(rawTupleArrays)
  ) {
    return {};
  }

  const next = {};
  Object.entries(rawTupleArrays).forEach(([key, rows]) => {
    if (!Array.isArray(rows)) return;
    next[key] = rows.map((row) => sanitizeTupleArrayRow(row));
  });
  return next;
}

function parseJsonIfPossible(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function createTupleArrayRowDraft(node, tupleValue) {
  const values = {};
  const exponents = {};
  applyLeafDefaults(node.children, values, exponents);
  if (tupleValue !== undefined) {
    fillValuesFromNodes(node.children, tupleValue, values);
  }
  return { values, exponents };
}

function createTupleArrayRowsFromValue(node, tupleArrayValue) {
  if (!Array.isArray(tupleArrayValue)) return [];
  return tupleArrayValue.map((rowValue) => createTupleArrayRowDraft(node, rowValue));
}

function collectTupleArrayNodes(nodes, target = []) {
  nodes.forEach((node) => {
    if (node.kind === "tupleArray") {
      target.push(node);
    }
    if (node.kind === "tuple") {
      collectTupleArrayNodes(node.children, target);
    }
  });
  return target;
}

function sanitizeMethodState(raw) {
  const safeRaw = raw && typeof raw === "object" ? raw : {};

  const values = {};
  if (safeRaw.values && typeof safeRaw.values === "object" && !Array.isArray(safeRaw.values)) {
    Object.entries(safeRaw.values).forEach(([key, value]) => {
      values[key] = String(value ?? "");
    });
  }

  const exponents = {};
  if (
    safeRaw.exponents &&
    typeof safeRaw.exponents === "object" &&
    !Array.isArray(safeRaw.exponents)
  ) {
    Object.entries(safeRaw.exponents).forEach(([key, value]) => {
      const parsed = Number(value || 0);
      exponents[key] = Number.isNaN(parsed) ? 0 : parsed;
    });
  }

  const sanitized = {
    values,
    exponents,
    tupleArrays: sanitizeTupleArrayMap(safeRaw.tupleArrays),
    payableValue: String(safeRaw.payableValue ?? ""),
  };

  if (Array.isArray(safeRaw.params)) {
    sanitized.params = safeRaw.params.map((item) => toInputString(item));
  }

  if (Array.isArray(safeRaw.legacyExponents)) {
    sanitized.legacyExponents = safeRaw.legacyExponents
      .map((item) => Number(item || 0))
      .map((item) => (Number.isNaN(item) ? 0 : item));
  } else if (Array.isArray(safeRaw.exponents)) {
    sanitized.legacyExponents = safeRaw.exponents
      .map((item) => Number(item || 0))
      .map((item) => (Number.isNaN(item) ? 0 : item));
  }

  return sanitized;
}

function normalizeMethodDraftState(raw, nodes) {
  const safeRaw = sanitizeMethodState(raw);
  const values = { ...safeRaw.values };
  const exponents = { ...safeRaw.exponents };
  const tupleArrays = {};
  Object.entries(safeRaw.tupleArrays || {}).forEach(([key, rows]) => {
    tupleArrays[key] = rows.map((row) => ({
      values: { ...(row.values || {}) },
      exponents: { ...(row.exponents || {}) },
    }));
  });
  const tupleArrayNodes = collectTupleArrayNodes(nodes);

  if (Array.isArray(safeRaw.params) && safeRaw.params.length) {
    nodes.forEach((node, index) => {
      const legacyValue = safeRaw.params[index];
      if (legacyValue === undefined) return;

      if (node.kind === "leaf") {
        values[node.key] = toInputString(legacyValue);
        return;
      }

      const parsedValue = parseJsonIfPossible(legacyValue) ?? legacyValue;

      if (node.kind === "tuple") {
        fillValuesFromTupleNode(node, parsedValue, values);
        return;
      }

      if (
        node.kind === "tupleArray" &&
        !Object.prototype.hasOwnProperty.call(tupleArrays, node.key)
      ) {
        tupleArrays[node.key] = createTupleArrayRowsFromValue(node, parsedValue);
      }
    });
  }

  tupleArrayNodes.forEach((node) => {
    if (Object.prototype.hasOwnProperty.call(tupleArrays, node.key)) return;

    const legacyValue = values[node.key];
    if (legacyValue === undefined) return;
    const parsedValue = parseJsonIfPossible(legacyValue);
    if (Array.isArray(parsedValue)) {
      tupleArrays[node.key] = createTupleArrayRowsFromValue(node, parsedValue);
    }
    delete values[node.key];
  });

  if (Array.isArray(safeRaw.legacyExponents) && safeRaw.legacyExponents.length) {
    nodes.forEach((node, index) => {
      if (node.kind !== "leaf") return;
      if (!SCALE_TYPES.has(node.type)) return;
      const exponent = Number(safeRaw.legacyExponents[index] || 0);
      exponents[node.key] = Number.isNaN(exponent) ? 0 : exponent;
    });
  }

  applyLeafDefaults(nodes, values, exponents);
  tupleArrayNodes.forEach((node) => {
    const hasRows = Object.prototype.hasOwnProperty.call(tupleArrays, node.key);
    if (!hasRows) {
      tupleArrays[node.key] = [createTupleArrayRowDraft(node)];
      return;
    }

    const rows = Array.isArray(tupleArrays[node.key]) ? tupleArrays[node.key] : [];
    tupleArrays[node.key] = rows.map((row) => {
      const safeRow = sanitizeTupleArrayRow(row);
      applyLeafDefaults(node.children, safeRow.values, safeRow.exponents);
      return safeRow;
    });
  });

  return {
    values,
    exponents,
    tupleArrays,
    payableValue: safeRaw.payableValue,
  };
}

function buildChildrenCallValue(children, values, exponents, tupleArrays) {
  const useObject = children.every((child) => Boolean(child.name));

  if (useObject) {
    const nextObject = {};
    children.forEach((child, index) => {
      const childValue = buildNodeCallValue(child, values, exponents, tupleArrays);
      if (child.name) {
        nextObject[child.name] = childValue;
      } else {
        nextObject[index] = childValue;
      }
    });
    return nextObject;
  }

  return children.map((child) => buildNodeCallValue(child, values, exponents, tupleArrays));
}

function buildNodeCallValue(node, values, exponents, tupleArrays = {}) {
  if (node.kind === "leaf") {
    const rawValue = values[node.key] || "";

    if (SCALE_TYPES.has(node.type)) {
      const exponent = Number(exponents[node.key] || 0);
      if (exponent > 0) {
        return parseDecimalWithExponent(rawValue, exponent);
      }
      if (rawValue.includes(".")) {
        throw new Error("uint 类型不支持小数，请选择 10^n 或改用整数。");
      }
    }

    return parseInputValue(rawValue, node.type);
  }

  if (node.kind === "tupleArray") {
    const rows = Array.isArray(tupleArrays[node.key]) ? tupleArrays[node.key] : [];
    return rows.map((row) => {
      const rowValues =
        row?.values && typeof row.values === "object" && !Array.isArray(row.values)
          ? row.values
          : {};
      const rowExponents =
        row?.exponents && typeof row.exponents === "object" && !Array.isArray(row.exponents)
          ? row.exponents
          : {};
      return buildChildrenCallValue(node.children, rowValues, rowExponents, {});
    });
  }

  return buildChildrenCallValue(node.children, values, exponents, tupleArrays);
}

function cloneMethodStates(methodStates) {
  return JSON.parse(JSON.stringify(methodStates || {}));
}

function sanitizeMethodStates(raw) {
  if (!raw || typeof raw !== "object") return {};
  const next = {};
  Object.entries(raw).forEach(([key, value]) => {
    next[key] = sanitizeMethodState(value);
  });
  return next;
}

function normalizePanelValues(panel) {
  return {
    rpcListText: String(panel?.rpcListText ?? DEFAULTS.rpcList),
    selectedRpc: String(panel?.selectedRpc ?? DEFAULTS.rpcList),
    explorerBase: String(panel?.explorerBase ?? DEFAULTS.explorerBase),
    explorerApi: String(panel?.explorerApi ?? DEFAULTS.explorerApi),
    explorerApiKey: String(panel?.explorerApiKey ?? DEFAULTS.explorerApiKey),
    chainId: String(panel?.chainId ?? DEFAULTS.chainId),
    contractAddress: String(panel?.contractAddress ?? DEFAULTS.contractAddress),
    abiText: String(panel?.abiText ?? DEFAULTS.abi),
  };
}

function extractTemplateList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray(raw.templates)) {
    return raw.templates;
  }
  if (raw && typeof raw === "object") return [raw];
  return [];
}

function sanitizeTemplate(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || "").trim();
  if (!name) return null;

  const panel = normalizePanelValues(raw.panel || {});
  const now = getCurrentIsoTime();

  return {
    id: String(raw.id || generateTemplateId()),
    name,
    panel,
    methodStates: sanitizeMethodStates(raw.methodStates),
    createdAt: String(raw.createdAt || now),
    updatedAt: String(raw.updatedAt || now),
  };
}

function loadTemplatesFromStorage() {
  try {
    const raw = localStorage.getItem(TEMPLATE_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    return extractTemplateList(parsed).map(sanitizeTemplate).filter(Boolean);
  } catch {
    return [];
  }
}

function MethodCard({
  fn,
  kind,
  explorerBase,
  onRead,
  onWrite,
  onPersist,
  methodStorageKey,
  savedCallState,
}) {
  const paramNodes = useMemo(() => buildParamNodes(fn.inputs || []), [fn]);

  const normalizedSavedState = useMemo(
    () => normalizeMethodDraftState(savedCallState, paramNodes),
    [savedCallState, paramNodes]
  );

  const [fieldValues, setFieldValues] = useState(normalizedSavedState.values);
  const [fieldExponents, setFieldExponents] = useState(normalizedSavedState.exponents);
  const [tupleArrayRows, setTupleArrayRows] = useState(normalizedSavedState.tupleArrays);
  const [payableValue, setPayableValue] = useState(normalizedSavedState.payableValue);
  const [output, setOutput] = useState(
    kind === "read" ? "调用结果将在此显示" : "交易状态将在此显示"
  );
  const [txHash, setTxHash] = useState("");
  const [loading, setLoading] = useState(false);
  const signature = getFunctionSignature(fn);

  useEffect(() => {
    setFieldValues(normalizedSavedState.values);
    setFieldExponents(normalizedSavedState.exponents);
    setTupleArrayRows(normalizedSavedState.tupleArrays);
    setPayableValue(normalizedSavedState.payableValue);
  }, [normalizedSavedState]);

  const persistCurrentInputs = () => {
    onPersist(methodStorageKey, {
      values: { ...fieldValues },
      exponents: { ...fieldExponents },
      tupleArrays: JSON.parse(JSON.stringify(tupleArrayRows || {})),
      payableValue,
    });
  };

  const handleValueChange = (key, value) => {
    setFieldValues((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleExponentChange = (key, value) => {
    setFieldExponents((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleTupleArrayValueChange = (tupleNode, rowIndex, fieldKey, value) => {
    setTupleArrayRows((prev) => {
      const tupleKey = tupleNode.key;
      const previousRows = Array.isArray(prev[tupleKey]) ? prev[tupleKey] : [];
      const rows = previousRows.map((row) => sanitizeTupleArrayRow(row));

      while (rows.length <= rowIndex) {
        rows.push(createTupleArrayRowDraft(tupleNode));
      }

      const targetRow = rows[rowIndex] || createTupleArrayRowDraft(tupleNode);
      targetRow.values[fieldKey] = value;
      rows[rowIndex] = targetRow;

      return {
        ...prev,
        [tupleKey]: rows,
      };
    });
  };

  const handleTupleArrayExponentChange = (tupleNode, rowIndex, fieldKey, value) => {
    setTupleArrayRows((prev) => {
      const tupleKey = tupleNode.key;
      const previousRows = Array.isArray(prev[tupleKey]) ? prev[tupleKey] : [];
      const rows = previousRows.map((row) => sanitizeTupleArrayRow(row));

      while (rows.length <= rowIndex) {
        rows.push(createTupleArrayRowDraft(tupleNode));
      }

      const targetRow = rows[rowIndex] || createTupleArrayRowDraft(tupleNode);
      targetRow.exponents[fieldKey] = value;
      rows[rowIndex] = targetRow;

      return {
        ...prev,
        [tupleKey]: rows,
      };
    });
  };

  const handleAddTupleArrayRow = (tupleNode) => {
    setTupleArrayRows((prev) => {
      const tupleKey = tupleNode.key;
      const previousRows = Array.isArray(prev[tupleKey]) ? prev[tupleKey] : [];
      const rows = previousRows.map((row) => sanitizeTupleArrayRow(row));
      rows.push(createTupleArrayRowDraft(tupleNode));
      return {
        ...prev,
        [tupleKey]: rows,
      };
    });
  };

  const handleRemoveTupleArrayRow = (tupleNode, rowIndex) => {
    setTupleArrayRows((prev) => {
      const tupleKey = tupleNode.key;
      const previousRows = Array.isArray(prev[tupleKey]) ? prev[tupleKey] : [];
      if (rowIndex < 0 || rowIndex >= previousRows.length) return prev;

      const rows = previousRows.map((row) => sanitizeTupleArrayRow(row));
      rows.splice(rowIndex, 1);

      return {
        ...prev,
        [tupleKey]: rows,
      };
    });
  };

  const renderNode = (node, depth = 0, rowContext = null) => {
    const displayName = node.name || `arg${node.path[node.path.length - 1] || 0}`;

    if (node.kind === "tuple") {
      return (
        <div className="tuple-group" key={node.key} style={{ marginLeft: depth > 0 ? 12 : 0 }}>
          <div className="tuple-heading">
            {displayName} ({node.type})
          </div>
          <div className="tuple-children">
            {node.children.map((child) => renderNode(child, depth + 1, rowContext))}
          </div>
        </div>
      );
    }

    if (node.kind === "tupleArray") {
      const rows = Array.isArray(tupleArrayRows[node.key]) ? tupleArrayRows[node.key] : [];

      return (
        <div className="tuple-group" key={node.key} style={{ marginLeft: depth > 0 ? 12 : 0 }}>
          <div className="tuple-array-header">
            <div className="tuple-heading">
              {displayName} ({node.type})
            </div>
            <button
              className="btn ghost tiny-btn"
              type="button"
              onClick={() => handleAddTupleArrayRow(node)}
            >
              新增一行
            </button>
          </div>

          {rows.length === 0 ? (
            <div className="tuple-array-empty">当前没有数据行，可点击“新增一行”。</div>
          ) : (
            <div className="tuple-array-rows">
              {rows.map((row, rowIndex) => {
                const safeRow = sanitizeTupleArrayRow(row);
                const nextContext = {
                  tupleNode: node,
                  rowIndex,
                  values: safeRow.values,
                  exponents: safeRow.exponents,
                };

                return (
                  <div className="tuple-array-row" key={`${node.key}-${rowIndex}`}>
                    <div className="tuple-array-row-header">
                      <span>第 {rowIndex + 1} 行</span>
                      <button
                        className="btn ghost tiny-btn danger-btn"
                        type="button"
                        onClick={() => handleRemoveTupleArrayRow(node, rowIndex)}
                      >
                        删除
                      </button>
                    </div>
                    <div className="tuple-children">
                      {node.children.map((child) => renderNode(child, depth + 1, nextContext))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    }

    const scopedValues = rowContext ? rowContext.values : fieldValues;
    const scopedExponents = rowContext ? rowContext.exponents : fieldExponents;
    const value = scopedValues[node.key] ?? "";
    const exponent = Number(scopedExponents[node.key] || 0);

    const handleScopedValueChange = (nextValue) => {
      if (rowContext) {
        handleTupleArrayValueChange(rowContext.tupleNode, rowContext.rowIndex, node.key, nextValue);
        return;
      }
      handleValueChange(node.key, nextValue);
    };

    const handleScopedExponentChange = (nextValue) => {
      if (rowContext) {
        handleTupleArrayExponentChange(
          rowContext.tupleNode,
          rowContext.rowIndex,
          node.key,
          nextValue
        );
        return;
      }
      handleExponentChange(node.key, nextValue);
    };

    return (
      <div className="param" key={node.key} style={{ marginLeft: depth > 0 ? 12 : 0 }}>
        <label>
          {displayName} ({node.type})
        </label>
        {SCALE_TYPES.has(node.type) ? (
          <div className="input-with-addon">
            <input
              type="text"
              placeholder={
                node.type.includes("[]") || node.type.startsWith("tuple")
                  ? "JSON 格式"
                  : "输入参数"
              }
              value={value}
              onChange={(event) => handleScopedValueChange(event.target.value)}
            />
            <select
              className="addon-select"
              value={exponent}
              onChange={(event) => handleScopedExponentChange(Number(event.target.value))}
            >
              {EXPONENT_OPTIONS.map((exp) => (
                <option key={exp} value={exp}>
                  10^{exp}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <input
            type="text"
            placeholder={
              node.type.includes("[]") || node.type.startsWith("tuple")
                ? "JSON 格式"
                : "输入参数"
            }
            value={value}
            onChange={(event) => handleScopedValueChange(event.target.value)}
          />
        )}
      </div>
    );
  };

  const handleCall = async () => {
    persistCurrentInputs();
    setLoading(true);
    setOutput(kind === "read" ? "正在调用..." : "正在发送交易...");
    setTxHash("");

    try {
      const parsedArgs = paramNodes.map((node) =>
        buildNodeCallValue(node, fieldValues, fieldExponents, tupleArrayRows)
      );

      if (kind === "read") {
        const result = await onRead(fn, parsedArgs);
        setOutput(stringifyResult(result));
        return;
      }

      const { hash, receiptPromise } = await onWrite(fn, parsedArgs, payableValue);
      setTxHash(hash);
      setOutput("交易已发送，等待钱包确认...");

      const receipt = await receiptPromise;
      if (!receipt) {
        setOutput("交易已发送。请稍后在区块浏览器查看。");
        return;
      }
      setOutput(
        receipt.status === "success"
          ? "交易已确认成功。"
          : "交易已确认，但可能失败。"
      );
    } catch (error) {
      setOutput(`调用失败：${error?.message || error}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <details className="method-card">
      <summary>
        <div>{fn.name}</div>
        <span className="method-meta">{signature}</span>
      </summary>

      <div className="method-body">
        {paramNodes.length > 0 && (
          <div className="param-grid">{paramNodes.map((node) => renderNode(node))}</div>
        )}

        {kind === "write" && fn.stateMutability === "payable" && (
          <div className="param">
            <label>Value (ETH)</label>
            <input
              type="text"
              placeholder="0.0"
              value={payableValue}
              onChange={(event) => setPayableValue(event.target.value)}
            />
          </div>
        )}

        <div className="actions">
          <button className="btn secondary" onClick={handleCall} disabled={loading}>
            {kind === "read" ? "调用" : "发起交易"}
          </button>
        </div>

        <div className="output">{output}</div>

        {kind === "write" && (
          <div className="tx-row">
            <span className="tx-hash">{txHash}</span>
            {txHash && explorerBase && (
              <a
                className="btn ghost"
                href={`${explorerBase.replace(/\/$/, "")}/tx/${txHash}`}
                target="_blank"
                rel="noopener"
              >
                查看交易
              </a>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

export default function App() {
  const [rpcListText, setRpcListText] = useState(DEFAULTS.rpcList);
  const [selectedRpc, setSelectedRpc] = useState(DEFAULTS.rpcList);
  const [explorerBase, setExplorerBase] = useState(DEFAULTS.explorerBase);
  const [explorerApi, setExplorerApi] = useState(DEFAULTS.explorerApi);
  const [explorerApiKey, setExplorerApiKey] = useState(DEFAULTS.explorerApiKey);
  const [chainId, setChainId] = useState(DEFAULTS.chainId);
  const [contractAddress, setContractAddress] = useState(DEFAULTS.contractAddress);
  const [abiText, setAbiText] = useState(DEFAULTS.abi);
  const [readFns, setReadFns] = useState([]);
  const [writeFns, setWriteFns] = useState([]);
  const [activeTab, setActiveTab] = useState("read");
  const [status, setStatus] = useState({ message: "", type: "" });

  const [templates, setTemplates] = useState([]);
  const [activeTemplateId, setActiveTemplateId] = useState("");
  const [templateNameInput, setTemplateNameInput] = useState("");
  const [methodDrafts, setMethodDrafts] = useState({});
  const [isTemplateMenuOpen, setIsTemplateMenuOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [exportSelection, setExportSelection] = useState({});

  const { isConnected, address } = useAccount();
  const walletChainId = useChainId();
  const { data: walletClient } = useWalletClient();

  const templateMenuRef = useRef(null);
  const importInputRef = useRef(null);
  const autoSwitchRef = useRef("");

  const rpcOptions = useMemo(() => parseRpcList(rpcListText), [rpcListText]);
  const parsedChainId = useMemo(() => parseChainIdValue(chainId), [chainId]);

  const activeTemplate = useMemo(
    () => templates.find((item) => item.id === activeTemplateId) || null,
    [templates, activeTemplateId]
  );

  useEffect(() => {
    setTemplates(loadTemplatesFromStorage());
  }, []);

  useEffect(() => {
    if (!selectedRpc || !rpcOptions.includes(selectedRpc)) {
      setSelectedRpc(rpcOptions[0] || "");
    }
  }, [rpcOptions, selectedRpc]);

  useEffect(() => {
    if (!isTemplateMenuOpen) return undefined;

    const handleOutsideClick = (event) => {
      if (templateMenuRef.current && !templateMenuRef.current.contains(event.target)) {
        setIsTemplateMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [isTemplateMenuOpen]);

  const publicClient = useMemo(() => {
    if (!selectedRpc) return null;
    return createPublicClient({ transport: http(selectedRpc) });
  }, [selectedRpc]);

  const updateStatus = (message, type = "") => {
    setStatus({ message, type });
  };

  const ensureWalletChain = async (targetChainId) => {
    if (!targetChainId || !window.ethereum?.request) return;

    const hexChainId = `0x${targetChainId.toString(16)}`;

    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexChainId }],
      });
    } catch (error) {
      const code = error?.code ?? error?.data?.originalError?.code;
      if (code !== 4902 || !selectedRpc) {
        throw error;
      }

      const explorerUrl = explorerBase ? explorerBase.replace(/\/$/, "") : undefined;
      const addParams = {
        chainId: hexChainId,
        chainName: `Chain ${targetChainId}`,
        nativeCurrency: {
          name: "Native Token",
          symbol: "NATIVE",
          decimals: 18,
        },
        rpcUrls: [selectedRpc],
      };

      if (explorerUrl) {
        addParams.blockExplorerUrls = [explorerUrl];
      }

      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [addParams],
      });

      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexChainId }],
      });
    }
  };

  useEffect(() => {
    if (!isConnected || !address) {
      autoSwitchRef.current = "";
      return;
    }

    if (!parsedChainId) return;
    if (walletChainId === parsedChainId) return;

    const switchKey = `${address}:${parsedChainId}`;
    if (autoSwitchRef.current === switchKey) return;

    autoSwitchRef.current = switchKey;
    ensureWalletChain(parsedChainId).catch(() => {
      updateStatus("钱包切换网络失败，请在钱包中手动切换。", "error");
    });
  }, [
    isConnected,
    address,
    parsedChainId,
    walletChainId,
    selectedRpc,
    explorerBase,
  ]);

  const getCurrentPanelValues = () => ({
    rpcListText,
    selectedRpc,
    explorerBase,
    explorerApi,
    explorerApiKey,
    chainId,
    contractAddress,
    abiText,
  });

  const applyPanelValues = (panel) => {
    const normalized = normalizePanelValues(panel);
    setRpcListText(normalized.rpcListText);
    setSelectedRpc(normalized.selectedRpc);
    setExplorerBase(normalized.explorerBase);
    setExplorerApi(normalized.explorerApi);
    setExplorerApiKey(normalized.explorerApiKey);
    setChainId(normalized.chainId);
    setContractAddress(normalized.contractAddress);
    setAbiText(normalized.abiText);
  };

  const persistTemplates = (updater) => {
    setTemplates((prevTemplates) => {
      const nextTemplates =
        typeof updater === "function" ? updater(prevTemplates) : updater;
      localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(nextTemplates));
      return nextTemplates;
    });
  };

  const fetchAbiFromExplorer = async (addressValue) => {
    if (!explorerApi) {
      throw new Error("未填写 ABI 且未提供浏览器 API 地址。\n请粘贴 ABI 或填写 API 地址。");
    }

    const url = new URL(explorerApi);
    url.searchParams.set("module", "contract");
    url.searchParams.set("action", "getabi");
    url.searchParams.set("address", addressValue);
    if (explorerApiKey) {
      url.searchParams.set("apikey", explorerApiKey);
    }
    if (parsedChainId) {
      url.searchParams.set("chainid", String(parsedChainId));
    }

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error("浏览器 API 请求失败。请检查地址与网络。");
    }

    const data = await response.json();
    if (data.status !== "1") {
      throw new Error(data.result || "ABI 获取失败。请确认合约已验证。");
    }

    return data.result;
  };

  const proxyEthCall = async ({ to, data }) => {
    if (!explorerApi) {
      throw new Error("未配置浏览器 API 地址，无法使用 RPC 代理调用。");
    }

    const url = new URL(explorerApi);
    url.searchParams.set("module", "proxy");
    url.searchParams.set("action", "eth_call");
    url.searchParams.set("to", to);
    url.searchParams.set("data", data);
    url.searchParams.set("tag", "latest");
    if (explorerApiKey) {
      url.searchParams.set("apikey", explorerApiKey);
    }
    if (parsedChainId) {
      url.searchParams.set("chainid", String(parsedChainId));
    }

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error("浏览器 API 代理请求失败。");
    }

    const payload = await response.json();
    if (payload?.error?.message) {
      throw new Error(payload.error.message);
    }
    if (payload?.status === "0") {
      throw new Error(payload.result || "浏览器 API 代理调用失败。");
    }

    const result = payload?.result;
    if (!result) {
      throw new Error("浏览器 API 代理返回未知格式。");
    }

    return result;
  };

  const callReadWithFallback = async (fn, args) => {
    if (!publicClient) {
      throw new Error("请先填写 RPC 端点。\n或确保 RPC 列表已选中。");
    }

    let rpcError;
    try {
      return await retryCall(
        () =>
          publicClient.readContract({
            address: contractAddress,
            abi: [fn],
            functionName: fn.name,
            args,
          }),
        3
      );
    } catch (error) {
      rpcError = error;
    }

    try {
      const data = encodeFunctionData({
        abi: [fn],
        functionName: fn.name,
        args,
      });
      const raw = await proxyEthCall({ to: contractAddress, data });
      return decodeFunctionResult({
        abi: [fn],
        functionName: fn.name,
        data: raw,
      });
    } catch (proxyError) {
      const rpcMessage = rpcError?.message || rpcError;
      const proxyMessage = proxyError?.message || proxyError;
      throw new Error(
        `RPC 调用失败（已重试 3 次）：${rpcMessage}\n浏览器 API 代理调用失败：${proxyMessage}`
      );
    }
  };

  const handleWrite = async (fn, args, valueEth) => {
    if (!isConnected) {
      throw new Error("请先连接钱包。");
    }
    if (!publicClient) {
      throw new Error("请先填写 RPC 端点。\n或确保 RPC 列表已选中。");
    }

    if (parsedChainId && walletChainId !== parsedChainId) {
      await ensureWalletChain(parsedChainId);
    }

    let signerClient = walletClient;
    if (!signerClient && window.ethereum?.request) {
      signerClient = createWalletClient({ transport: custom(window.ethereum) });
    }
    if (!signerClient) {
      throw new Error("未获取到钱包签名器，请重新连接钱包。");
    }

    let account = signerClient.account;
    if (!account) {
      const addresses = await signerClient.requestAddresses();
      if (!addresses || addresses.length === 0) {
        throw new Error("未获取到钱包地址，请重新连接钱包。");
      }
      account = addresses[0];
    }

    const value = valueEth?.trim() ? parseEther(valueEth.trim()) : undefined;

    const hash = await signerClient.writeContract({
      address: contractAddress,
      abi: [fn],
      functionName: fn.name,
      args,
      value,
      account,
    });

    const receiptPromise = publicClient.waitForTransactionReceipt({ hash });
    return { hash, receiptPromise };
  };

  const loadContract = async () => {
    updateStatus("", "");

    if (!selectedRpc) {
      updateStatus("请先填写 RPC 端点。", "error");
      return;
    }

    if (!contractAddress) {
      updateStatus("请填写合约地址。", "error");
      return;
    }

    if (!isAddress(contractAddress)) {
      updateStatus("合约地址格式不正确。", "error");
      return;
    }

    try {
      let resolvedAbi = abiText.trim();
      if (!resolvedAbi) {
        updateStatus("正在通过浏览器 API 拉取 ABI...", "");
        resolvedAbi = await fetchAbiFromExplorer(contractAddress);
        setAbiText(resolvedAbi);
      }

      const parsed = JSON.parse(resolvedAbi);
      if (!Array.isArray(parsed)) {
        throw new Error("ABI 格式无效，请确认是 JSON 数组。");
      }

      const functions = parsed.filter((item) => item.type === "function");
      setReadFns(functions.filter((fn) => isReadFunction(fn)));
      setWriteFns(functions.filter((fn) => !isReadFunction(fn)));
      updateStatus("合约已加载完成。", "success");
    } catch (error) {
      updateStatus(`加载失败：${error?.message || error}`, "error");
    }
  };

  const handlePersistMethodState = (methodKey, nextState) => {
    const safeState = sanitizeMethodState(nextState);

    setMethodDrafts((prev) => ({
      ...prev,
      [methodKey]: safeState,
    }));

    if (!activeTemplateId) return;

    persistTemplates((prevTemplates) =>
      prevTemplates.map((template) => {
        if (template.id !== activeTemplateId) return template;
        return {
          ...template,
          methodStates: {
            ...(template.methodStates || {}),
            [methodKey]: safeState,
          },
          updatedAt: getCurrentIsoTime(),
        };
      })
    );
  };

  const handleSelectTemplate = (templateId) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;

    applyPanelValues(template.panel);
    setMethodDrafts(cloneMethodStates(template.methodStates));
    setTemplateNameInput(template.name);
    setActiveTemplateId(template.id);
    setIsTemplateMenuOpen(false);
    updateStatus(`已加载模板：${template.name}`, "success");
  };

  const handleDeleteTemplate = (templateId) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;

    const confirmed = window.confirm(`确认删除模板「${template.name}」？`);
    if (!confirmed) return;

    persistTemplates((prevTemplates) =>
      prevTemplates.filter((item) => item.id !== templateId)
    );

    if (activeTemplateId === templateId) {
      setActiveTemplateId("");
      setTemplateNameInput("");
      setMethodDrafts({});
    }

    updateStatus(`已删除模板：${template.name}`, "success");
  };

  const handleSaveOrUpdateTemplate = () => {
    const panel = getCurrentPanelValues();
    const now = getCurrentIsoTime();

    if (activeTemplate) {
      const nextName = templateNameInput.trim() || activeTemplate.name;
      persistTemplates((prevTemplates) =>
        prevTemplates.map((item) => {
          if (item.id !== activeTemplate.id) return item;
          return {
            ...item,
            name: nextName,
            panel,
            methodStates: cloneMethodStates(methodDrafts),
            updatedAt: now,
          };
        })
      );
      setTemplateNameInput(nextName);
      updateStatus(`模板已更新：${nextName}`, "success");
      return;
    }

    const nameFromInput = templateNameInput.trim();
    const promptName = window.prompt("请输入模板名称") || "";
    const finalName = (nameFromInput || promptName).trim();
    if (!finalName) {
      updateStatus("模板名称不能为空。", "error");
      return;
    }

    const nextTemplate = {
      id: generateTemplateId(),
      name: finalName,
      panel,
      methodStates: cloneMethodStates(methodDrafts),
      createdAt: now,
      updatedAt: now,
    };

    persistTemplates((prevTemplates) => [...prevTemplates, nextTemplate]);
    setActiveTemplateId(nextTemplate.id);
    setTemplateNameInput(finalName);
    updateStatus(`模板已保存：${finalName}`, "success");
  };

  const handleImportTemplates = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";

    if (!files.length) return;

    const importedTemplates = [];
    let invalidFiles = 0;

    for (const file of files) {
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const list = extractTemplateList(parsed);
        importedTemplates.push(...list.map(sanitizeTemplate).filter(Boolean));
      } catch {
        invalidFiles += 1;
      }
    }

    if (!importedTemplates.length) {
      updateStatus("导入失败：未读取到有效模板。", "error");
      return;
    }

    persistTemplates((prevTemplates) => {
      const usedIds = new Set(prevTemplates.map((item) => item.id));
      const nextTemplates = [...prevTemplates];

      importedTemplates.forEach((template) => {
        let nextId = template.id;
        while (usedIds.has(nextId)) {
          nextId = generateTemplateId();
        }
        usedIds.add(nextId);
        nextTemplates.push({ ...template, id: nextId, updatedAt: getCurrentIsoTime() });
      });

      return nextTemplates;
    });

    const invalidMessage = invalidFiles ? `，${invalidFiles} 个文件解析失败` : "";
    updateStatus(`成功导入 ${importedTemplates.length} 个模板${invalidMessage}。`, "success");
  };

  const openExportModal = () => {
    if (!templates.length) {
      updateStatus("当前没有可导出的模板。", "error");
      return;
    }

    const nextSelection = {};
    templates.forEach((template) => {
      nextSelection[template.id] = false;
    });

    setExportSelection(nextSelection);
    setIsExportModalOpen(true);
  };

  const handleToggleExportTemplate = (templateId) => {
    setExportSelection((prev) => ({
      ...prev,
      [templateId]: !prev[templateId],
    }));
  };

  const handleToggleExportAll = () => {
    const allChecked =
      templates.length > 0 && templates.every((template) => exportSelection[template.id]);

    const nextSelection = {};
    templates.forEach((template) => {
      nextSelection[template.id] = !allChecked;
    });
    setExportSelection(nextSelection);
  };

  const handleConfirmExport = () => {
    const selectedTemplates = templates.filter((template) => exportSelection[template.id]);

    if (!selectedTemplates.length) {
      updateStatus("请至少选择一个模板进行导出。", "error");
      return;
    }

    const payload = {
      version: TEMPLATE_EXPORT_VERSION,
      exportedAt: getCurrentIsoTime(),
      templates: selectedTemplates,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `contract-templates-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    setIsExportModalOpen(false);
    updateStatus(`已导出 ${selectedTemplates.length} 个模板。`, "success");
  };

  const resetAll = () => {
    setRpcListText("");
    setSelectedRpc("");
    setExplorerBase("");
    setExplorerApi("");
    setExplorerApiKey("");
    setChainId("");
    setContractAddress("");
    setAbiText("");
    setReadFns([]);
    setWriteFns([]);
    setMethodDrafts({});
    updateStatus("已清空。", "");
  };

  const activeList = activeTab === "read" ? readFns : writeFns;
  const emptyText =
    activeTab === "read" ? "请先加载合约。" : "加载合约后，这里会展示可写方法。";

  return (
    <div>
      <div className="bg-orb bg-orb-1"></div>
      <div className="bg-orb bg-orb-2"></div>

      <header className="hero">
        <div>
          <p className="eyebrow">Common EVM Contract Dashboard</p>
          <h1>通用 EVM 合约查看与调用面板</h1>
          <p className="subtitle">
            提供 RPC、交易浏览器与合约地址，一键加载 Read / Write 方法，快速调用与发交易。
          </p>
        </div>

        <ConnectButton.Custom>
          {({ account, chain, openConnectModal, openAccountModal, openChainModal, mounted }) => {
            const connected = mounted && account && chain;
            const label = connected ? shortAddress(account.address) : "未连接钱包";

            return (
              <div className="wallet">
                <div className="wallet-status">
                  <span className={`dot ${connected ? "online" : ""}`}></span>
                  <span id="walletText">{label}</span>
                </div>

                {!connected ? (
                  <button className="btn secondary" onClick={openConnectModal}>
                    连接钱包
                  </button>
                ) : chain.unsupported ? (
                  <button className="btn secondary" onClick={openChainModal}>
                    切换网络
                  </button>
                ) : (
                  <button className="btn secondary" onClick={openAccountModal}>
                    管理钱包
                  </button>
                )}
              </div>
            );
          }}
        </ConnectButton.Custom>
      </header>

      <main className="layout">
        <section className="panel">
          <h2>基础配置</h2>

          <div className="template-toolbar">
            <div className="template-picker" ref={templateMenuRef}>
              <button
                className="template-trigger"
                type="button"
                onClick={() => setIsTemplateMenuOpen((prev) => !prev)}
              >
                {activeTemplate ? activeTemplate.name : "选择模板"}
              </button>

              {isTemplateMenuOpen && (
                <div className="template-menu">
                  {templates.length === 0 ? (
                    <div className="template-empty">暂无模板</div>
                  ) : (
                    templates.map((template) => (
                      <div
                        className={`template-item ${template.id === activeTemplateId ? "active" : ""}`}
                        key={template.id}
                      >
                        <button
                          className="template-item-main"
                          type="button"
                          onClick={() => handleSelectTemplate(template.id)}
                        >
                          {template.name}
                        </button>
                        <button
                          className="template-delete"
                          type="button"
                          onClick={() => handleDeleteTemplate(template.id)}
                          title="删除模板"
                        >
                          x
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            <button
              className="btn ghost small-btn"
              type="button"
              onClick={() => importInputRef.current?.click()}
            >
              导入
            </button>
            <button className="btn ghost small-btn" type="button" onClick={openExportModal}>
              导出
            </button>

            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              multiple
              onChange={handleImportTemplates}
              style={{ display: "none" }}
            />
          </div>

          <label className="field">
            <span>模板名称（用于保存/修改）</span>
            <input
              type="text"
              value={templateNameInput}
              placeholder="输入模板名称"
              onChange={(event) => setTemplateNameInput(event.target.value)}
            />
          </label>

          <label className="field">
            <span>RPC 端点列表（一行一个）</span>
            <textarea
              rows={5}
              value={rpcListText}
              placeholder="https://mainnet.infura.io/v3/xxx\nhttps://rpc.ankr.com/eth"
              onChange={(event) => setRpcListText(event.target.value)}
            ></textarea>
          </label>

          <label className="field">
            <span>当前使用的 RPC</span>
            <select value={selectedRpc} onChange={(event) => setSelectedRpc(event.target.value)}>
              {rpcOptions.length === 0 && <option value="">请先填写 RPC</option>}
              {rpcOptions.map((rpc, index) => (
                <option value={rpc} key={rpc}>
                  {index + 1}. {rpc}
                </option>
              ))}
            </select>
          </label>

          <div className="field-grid">
            <label className="field">
              <span>交易浏览器地址（用于打开交易详情）</span>
              <input
                type="text"
                value={explorerBase}
                placeholder="https://etherscan.io"
                onChange={(event) => setExplorerBase(event.target.value)}
              />
            </label>
            <label className="field">
              <span>链 ID（用于钱包默认连接网络）</span>
              <input
                type="text"
                value={chainId}
                placeholder="1"
                onChange={(event) => setChainId(event.target.value)}
              />
            </label>
          </div>

          <div className="field-grid">
            <label className="field">
              <span>浏览器 API 地址（用于拉取 ABI，可选）</span>
              <input
                type="text"
                value={explorerApi}
                placeholder="https://api.etherscan.io/api"
                onChange={(event) => setExplorerApi(event.target.value)}
              />
            </label>
            <label className="field">
              <span>API Key（可选）</span>
              <input
                type="text"
                value={explorerApiKey}
                placeholder="在此填写 API Key"
                onChange={(event) => setExplorerApiKey(event.target.value)}
              />
            </label>
          </div>

          <label className="field">
            <span>合约地址</span>
            <input
              type="text"
              value={contractAddress}
              placeholder="0x..."
              onChange={(event) => setContractAddress(event.target.value)}
            />
          </label>

          <label className="field">
            <span>ABI（可选，留空会尝试通过浏览器 API 拉取）</span>
            <textarea
              rows={6}
              value={abiText}
              placeholder='[{"type":"function","name":"balanceOf","inputs":...}]'
              onChange={(event) => setAbiText(event.target.value)}
            ></textarea>
          </label>

          <div className="actions">
            <button className="btn primary" onClick={loadContract}>
              加载合约
            </button>
            <button className="btn secondary" onClick={handleSaveOrUpdateTemplate}>
              {activeTemplate ? "更新模板" : "保存模板"}
            </button>
            <button className="btn ghost" onClick={resetAll}>
              清空
            </button>
          </div>

          <div className={`status ${status.type}`}>{status.message}</div>
        </section>

        <section className="content">
          <div className="tabs">
            <button
              className={`tab ${activeTab === "read" ? "active" : ""}`}
              onClick={() => setActiveTab("read")}
            >
              Read Contract
            </button>
            <button
              className={`tab ${activeTab === "write" ? "active" : ""}`}
              onClick={() => setActiveTab("write")}
            >
              Write Contract
            </button>
          </div>

          <div className="section-header">
            <h2>{activeTab === "read" ? "Read 方法" : "Write 方法"}</h2>
            <span className="pill">{activeList.length}</span>
          </div>

          <div className={`method-list ${activeList.length ? "" : "empty"}`}>
            {activeList.length === 0
              ? emptyText
              : activeList.map((fn) => {
                  const methodStorageKey = buildMethodStorageKey(activeTab, fn);
                  return (
                    <MethodCard
                      key={methodStorageKey}
                      fn={fn}
                      kind={activeTab}
                      explorerBase={explorerBase}
                      onRead={callReadWithFallback}
                      onWrite={handleWrite}
                      onPersist={handlePersistMethodState}
                      methodStorageKey={methodStorageKey}
                      savedCallState={methodDrafts[methodStorageKey]}
                    />
                  );
                })}
          </div>
        </section>
      </main>

      {isExportModalOpen && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h3>导出模板</h3>
            <button className="link-btn" type="button" onClick={handleToggleExportAll}>
              全部选择 / 取消全选
            </button>

            <div className="export-list">
              {templates.map((template) => (
                <label className="export-item" key={template.id}>
                  <input
                    type="checkbox"
                    checked={Boolean(exportSelection[template.id])}
                    onChange={() => handleToggleExportTemplate(template.id)}
                  />
                  <span>{template.name}</span>
                </label>
              ))}
            </div>

            <div className="actions">
              <button className="btn primary" type="button" onClick={handleConfirmExport}>
                导出选中
              </button>
              <button
                className="btn ghost"
                type="button"
                onClick={() => setIsExportModalOpen(false)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="footer">
        提示：Read 方法不需要钱包即可调用，Write 方法需连接钱包并签名。
      </footer>
    </div>
  );
}
