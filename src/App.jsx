import React, { useEffect, useMemo, useRef, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId, useWalletClient } from "wagmi";
import QRCode from "qrcode";
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
import {
  getCurrentUnixTimestampSeconds,
  matchesAutoTimestampParamName,
} from "./methodParamUtils";
import {
  filterTemplatesByName,
  sortTemplatesByName,
} from "./templateUtils";

const DEFAULTS = {
  rpcList: "",
  chainId: "",
  explorerBase: "",
  explorerApi: "",
  explorerApiKey: "",
  contractAddress: "",
  abi: "",
};

const TEMPLATE_STORAGE_KEY = "common-evm-dashboard.templates.v1";
const TEMPLATE_EXPORT_VERSION = 1;
const EXPONENT_OPTIONS = [0, 6, 9, 12, 18, 24];
const SCALE_TYPES = new Set(["uint256", "uint128"]);
const QR_SHARE_MAX_LENGTH = 2950;
const QR_IMPORT_HASH_KEY = "import";
const QR_COMPRESSED_TEXT_PREFIX = "CECD1:";
const KNOWN_PROXY_ABI_BY_NAME = {
  TransparentUpgradeableProxy: [
    {
      type: "function",
      name: "admin",
      stateMutability: "nonpayable",
      inputs: [],
      outputs: [{ name: "", type: "address" }],
    },
    {
      type: "function",
      name: "implementation",
      stateMutability: "nonpayable",
      inputs: [],
      outputs: [{ name: "", type: "address" }],
    },
    {
      type: "function",
      name: "changeAdmin",
      stateMutability: "nonpayable",
      inputs: [{ name: "newAdmin", type: "address" }],
      outputs: [],
    },
    {
      type: "function",
      name: "upgradeTo",
      stateMutability: "nonpayable",
      inputs: [{ name: "newImplementation", type: "address" }],
      outputs: [],
    },
    {
      type: "function",
      name: "upgradeToAndCall",
      stateMutability: "payable",
      inputs: [
        { name: "newImplementation", type: "address" },
        { name: "data", type: "bytes" },
      ],
      outputs: [],
    },
  ],
  OptimizedTransparentUpgradeableProxy: [
    {
      type: "function",
      name: "admin",
      stateMutability: "nonpayable",
      inputs: [],
      outputs: [{ name: "", type: "address" }],
    },
    {
      type: "function",
      name: "implementation",
      stateMutability: "nonpayable",
      inputs: [],
      outputs: [{ name: "", type: "address" }],
    },
    {
      type: "function",
      name: "changeAdmin",
      stateMutability: "nonpayable",
      inputs: [{ name: "newAdmin", type: "address" }],
      outputs: [],
    },
    {
      type: "function",
      name: "upgradeTo",
      stateMutability: "nonpayable",
      inputs: [{ name: "newImplementation", type: "address" }],
      outputs: [],
    },
    {
      type: "function",
      name: "upgradeToAndCall",
      stateMutability: "payable",
      inputs: [
        { name: "newImplementation", type: "address" },
        { name: "data", type: "bytes" },
      ],
      outputs: [],
    },
  ],
};

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

function buildScopedMethodStorageKey(scope, kind, fn) {
  const baseKey = buildMethodStorageKey(kind, fn);
  return scope === "contract" ? baseKey : `${scope}:${baseKey}`;
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
    const abiName = String(param?.name || "");
    const name = abiName || `arg${index}`;

    if (isTupleArrayParam(param)) {
      return {
        kind: "tupleArray",
        key,
        abiName,
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
        abiName,
        name,
        type: param.type,
        path: currentPath,
        children: buildParamNodes(param.components, currentPath, useRelativePath),
      };
    }

    return {
      kind: "leaf",
      key,
      abiName,
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

function buildExplorerAddressUrl(explorerBase, address) {
  if (!explorerBase || !address) return "";
  return `${explorerBase.replace(/\/$/, "")}/address/${address}`;
}

function parseExplorerProxyFlag(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function getImplementationAddressFromMetadata(metadata) {
  const candidates = [metadata?.Implementation, metadata?.ImplementationAddress];
  for (const value of candidates) {
    const candidate = String(value || "").trim();
    if (candidate && isAddress(candidate)) {
      return candidate;
    }
  }
  return "";
}

function parseAbiTextToFunctions(rawAbiText) {
  const parsed = JSON.parse(rawAbiText);
  if (!Array.isArray(parsed)) {
    throw new Error("ABI 格式无效，请确认是 JSON 数组。");
  }

  return parsed.filter((item) => item.type === "function");
}

function buildTemplateExportPayload(selectedTemplates) {
  return {
    version: TEMPLATE_EXPORT_VERSION,
    exportedAt: getCurrentIsoTime(),
    templates: selectedTemplates,
  };
}

function compactStringMap(mapLike) {
  const next = {};
  Object.entries(mapLike || {}).forEach(([key, value]) => {
    const normalized = String(value ?? "").trim();
    if (normalized) {
      next[key] = normalized;
    }
  });
  return next;
}

function compactExponentMap(mapLike) {
  const next = {};
  Object.entries(mapLike || {}).forEach(([key, value]) => {
    const normalized = Number(value || 0);
    if (!Number.isNaN(normalized) && normalized !== 0) {
      next[key] = normalized;
    }
  });
  return next;
}

function compactTupleArrayMapForQrShare(tupleArrays) {
  const next = {};

  Object.entries(tupleArrays || {}).forEach(([key, rows]) => {
    if (!Array.isArray(rows)) return;

    const compactRows = rows
      .map((row) => {
        const values = compactStringMap(row?.values);
        const exponents = compactExponentMap(row?.exponents);
        if (!Object.keys(values).length && !Object.keys(exponents).length) {
          return null;
        }
        return { values, exponents };
      })
      .filter(Boolean);

    if (compactRows.length) {
      next[key] = compactRows;
    }
  });

  return next;
}

function compactMethodStateForQrShare(raw) {
  const safeState = sanitizeMethodState(raw);
  const values = compactStringMap(safeState.values);
  const exponents = compactExponentMap(safeState.exponents);
  const tupleArrays = compactTupleArrayMapForQrShare(safeState.tupleArrays);
  const payableValue = String(safeState.payableValue || "").trim();

  const next = {};
  if (Object.keys(values).length) {
    next.values = values;
  }
  if (Object.keys(exponents).length) {
    next.exponents = exponents;
  }
  if (Object.keys(tupleArrays).length) {
    next.tupleArrays = tupleArrays;
  }
  if (payableValue) {
    next.payableValue = payableValue;
  }

  return next;
}

function compactMethodStatesForQrShare(methodStates) {
  const next = {};

  Object.entries(methodStates || {}).forEach(([methodKey, methodState]) => {
    const compactState = compactMethodStateForQrShare(methodState);
    if (Object.keys(compactState).length) {
      next[methodKey] = compactState;
    }
  });

  return next;
}

function stripTemplateAbiForQrShare(template) {
  const normalizedPanel = normalizePanelValues(template?.panel);
  const compactPanel = {};

  Object.entries({
    rpcListText: normalizedPanel.rpcListText,
    selectedRpc: normalizedPanel.selectedRpc,
    explorerBase: normalizedPanel.explorerBase,
    explorerApi: normalizedPanel.explorerApi,
    explorerApiKey: normalizedPanel.explorerApiKey,
    chainId: normalizedPanel.chainId,
    contractAddress: normalizedPanel.contractAddress,
  }).forEach(([key, value]) => {
    const nextValue = String(value || "").trim();
    if (nextValue) {
      compactPanel[key] = nextValue;
    }
  });

  return {
    name: String(template?.name || "").trim(),
    panel: compactPanel,
    methodStates: compactMethodStatesForQrShare(template?.methodStates),
  };
}

function buildQrTemplateExportPayload(selectedTemplates) {
  return {
    version: TEMPLATE_EXPORT_VERSION,
    exportedAt: getCurrentIsoTime(),
    templates: selectedTemplates.map(stripTemplateAbiForQrShare),
  };
}

function supportsCompressedQrShare() {
  return (
    typeof CompressionStream !== "undefined" &&
    typeof DecompressionStream !== "undefined"
  );
}

function bytesToBase64Url(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(base64Url) {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function compressTextPayload(text) {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  await writer.write(new TextEncoder().encode(text));
  await writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(buffer);
}

async function decompressTextPayload(payload) {
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  await writer.write(base64UrlToBytes(payload));
  await writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  return new TextDecoder().decode(buffer);
}

async function buildCompressedQrShareText(text) {
  if (!supportsCompressedQrShare()) {
    throw new Error("当前浏览器不支持压缩二维码分享。");
  }

  const compressedPayload = bytesToBase64Url(await compressTextPayload(text));
  return {
    payload: compressedPayload,
    qrText: `${QR_COMPRESSED_TEXT_PREFIX}${compressedPayload}`,
  };
}

async function resolveQrExportText(text) {
  const rawText = String(text || "");
  console.log("[QR_EXPORT_RAW_LENGTH]", rawText.length);
  console.log("[QR_EXPORT_RAW_TEXT]", rawText);

  if (rawText.length <= QR_SHARE_MAX_LENGTH) {
    return {
      qrText: rawText,
      mode: "raw",
      payloadLength: rawText.length,
    };
  }

  const { payload, qrText } = await withTimeout(
    buildCompressedQrShareText(rawText),
    2000,
    "二维码压缩超时，请检查导出内容是否过大。"
  );

  if (qrText.length > QR_SHARE_MAX_LENGTH) {
    throw new Error(
      `二维码文本仍然过长（原始 ${rawText.length} 字符，压缩后 ${payload.length} 字符），单个二维码无法承载。`
    );
  }

  return {
    qrText,
    mode: "compressed",
    payloadLength: payload.length,
  };
}

function withTimeout(promise, timeoutMs, errorMessage) {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);

    promise
      .then((value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        globalThis.clearTimeout(timer);
        reject(error);
      });
  });
}

function svgToDataUrl(svgMarkup) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`;
}

async function normalizeImportedText(text) {
  const sourceText = String(text || "").trim();
  if (!sourceText) {
    throw new Error("未读取到有效模板。");
  }

  if (sourceText.startsWith(QR_COMPRESSED_TEXT_PREFIX)) {
    return decompressTextPayload(sourceText.slice(QR_COMPRESSED_TEXT_PREFIX.length));
  }

  try {
    const parsedUrl = new URL(sourceText);
    const hashValue = String(parsedUrl.hash || "").replace(/^#/, "");
    const params = new URLSearchParams(hashValue);
    const importPayload = params.get(QR_IMPORT_HASH_KEY);
    if (importPayload) {
      return decompressTextPayload(importPayload);
    }
  } catch {
    // not a URL, continue as raw JSON text
  }

  return sourceText;
}

function normalizeAbiText(rawAbiText) {
  if (!rawAbiText) return "";
  return JSON.stringify(JSON.parse(rawAbiText));
}

function getKnownProxyFunctions(contractName) {
  const normalizedName = String(contractName || "").trim();
  if (!normalizedName) return null;

  if (KNOWN_PROXY_ABI_BY_NAME[normalizedName]) {
    return KNOWN_PROXY_ABI_BY_NAME[normalizedName];
  }

  const lowerName = normalizedName.toLowerCase();
  if (
    lowerName.includes("transparentupgradeableproxy") ||
    lowerName.includes("adminupgradeabilityproxy") ||
    lowerName.includes("transparentproxy")
  ) {
    return KNOWN_PROXY_ABI_BY_NAME.TransparentUpgradeableProxy;
  }

  if (
    lowerName.includes("erc1967proxy") ||
    lowerName.includes("beaconproxy") ||
    lowerName.includes("uupsproxy") ||
    lowerName === "proxy"
  ) {
    return [];
  }

  return null;
}

function buildReusablePanelValues(panel) {
  const normalized = normalizePanelValues(panel);
  return {
    ...normalized,
    contractAddress: "",
    abiText: "",
  };
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

export function MethodCard({
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
    const showTimestampShortcut = matchesAutoTimestampParamName(node.abiName);

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
        <div className="param-input-row">
          {SCALE_TYPES.has(node.type) ? (
            <div className="input-with-addon">
              <input
                type="text"
                aria-label={`${displayName} (${node.type})`}
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
              aria-label={`${displayName} (${node.type})`}
              placeholder={
                node.type.includes("[]") || node.type.startsWith("tuple")
                  ? "JSON 格式"
                  : "输入参数"
              }
              value={value}
              onChange={(event) => handleScopedValueChange(event.target.value)}
            />
          )}

          {showTimestampShortcut && (
            <button
              className="param-shortcut-btn"
              type="button"
              aria-label="填入当前秒级时间戳"
              title="填入当前秒级时间戳"
              onClick={() => handleScopedValueChange(getCurrentUnixTimestampSeconds())}
            >
              ⏱
            </button>
          )}
        </div>
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
  const [proxyReadFns, setProxyReadFns] = useState([]);
  const [proxyWriteFns, setProxyWriteFns] = useState([]);
  const [proxyInfo, setProxyInfo] = useState(null);
  const [activeTab, setActiveTab] = useState("read");
  const [activeScope, setActiveScope] = useState("contract");
  const [status, setStatus] = useState({ message: "", type: "" });

  const [templates, setTemplates] = useState([]);
  const [activeTemplateId, setActiveTemplateId] = useState("");
  const [templateNameInput, setTemplateNameInput] = useState("");
  const [templateSearchText, setTemplateSearchText] = useState("");
  const [methodDrafts, setMethodDrafts] = useState({});
  const [isTemplateMenuOpen, setIsTemplateMenuOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importMode, setImportMode] = useState("file");
  const [importJsonText, setImportJsonText] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [exportSelection, setExportSelection] = useState({});
  const [exportPreviewText, setExportPreviewText] = useState("");
  const [exportQrDataUrl, setExportQrDataUrl] = useState("");
  const [exportQrError, setExportQrError] = useState("");
  const [exportQrHint, setExportQrHint] = useState("");
  const [exportQrBusy, setExportQrBusy] = useState(false);
  const [exportCopySuccess, setExportCopySuccess] = useState(false);
  const [pendingTemplateContractReload, setPendingTemplateContractReload] = useState(false);

  const { isConnected, address } = useAccount();
  const walletChainId = useChainId();
  const { data: walletClient } = useWalletClient();

  const templateMenuRef = useRef(null);
  const autoSwitchRef = useRef("");

  const rpcOptions = useMemo(() => parseRpcList(rpcListText), [rpcListText]);
  const parsedChainId = useMemo(() => parseChainIdValue(chainId), [chainId]);

  const activeTemplate = useMemo(
    () => templates.find((item) => item.id === activeTemplateId) || null,
    [templates, activeTemplateId]
  );
  const sortedTemplates = useMemo(() => sortTemplatesByName(templates), [templates]);
  const filteredTemplateOptions = useMemo(
    () => filterTemplatesByName(sortedTemplates, templateSearchText),
    [sortedTemplates, templateSearchText]
  );
  const selectedExportTemplates = useMemo(
    () =>
      sortTemplatesByName(templates.filter((template) => exportSelection[template.id])),
    [exportSelection, templates]
  );

  useEffect(() => {
    setTemplates(loadTemplatesFromStorage());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const hashValue = String(window.location.hash || "").replace(/^#/, "");
    const params = new URLSearchParams(hashValue);
    const importPayload = params.get(QR_IMPORT_HASH_KEY);

    if (!importPayload) return undefined;

    let cancelled = false;

    (async () => {
      try {
        const text = await decompressTextPayload(importPayload);
        if (cancelled) return;

        const importedTemplates = parseImportedTemplatesFromText(text);
        const { count, insertedTemplates } = mergeImportedTemplates(importedTemplates);
        if (cancelled || !count || !insertedTemplates.length) return;

        const firstTemplate = insertedTemplates[0];
        applyPanelValues(firstTemplate.panel);
        clearLoadedContractState();
        setMethodDrafts(cloneMethodStates(firstTemplate.methodStates));
        setTemplateNameInput(firstTemplate.name);
        setActiveTemplateId(firstTemplate.id);
        setPendingTemplateContractReload(true);
        updateStatus(`已通过二维码导入 ${count} 个模板。`, "success");
      } catch (error) {
        if (cancelled) return;
        updateStatus(`二维码导入失败：${error?.message || error}`, "error");
      } finally {
        if (!cancelled) {
          window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
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

  useEffect(() => {
    if (!isTemplateMenuOpen) {
      setTemplateSearchText("");
    }
  }, [isTemplateMenuOpen]);

  useEffect(() => {
    if (!isExportModalOpen) {
      setExportPreviewText("");
      setExportQrDataUrl("");
      setExportQrError("");
      setExportQrHint("");
      setExportQrBusy(false);
      setExportCopySuccess(false);
      return;
    }

    const nextPreview = selectedExportTemplates.length
      ? JSON.stringify(buildTemplateExportPayload(selectedExportTemplates), null, 2)
      : "";
    setExportPreviewText(nextPreview);
  }, [isExportModalOpen, selectedExportTemplates]);

  useEffect(() => {
    if (!exportCopySuccess) return undefined;

    const timer = window.setTimeout(() => {
      setExportCopySuccess(false);
    }, 1800);

    return () => {
      window.clearTimeout(timer);
    };
  }, [exportCopySuccess]);

  useEffect(() => {
    if (!pendingTemplateContractReload) return undefined;

    setPendingTemplateContractReload(false);

    const hasContract = Boolean(contractAddress.trim());
    const hasLoadSource = Boolean(abiText.trim() || explorerApi.trim());
    const hasRpc = Boolean(selectedRpc.trim());

    if (!hasContract || !hasLoadSource || !hasRpc) {
      return undefined;
    }

    loadContract();
    return undefined;
  }, [
    pendingTemplateContractReload,
    contractAddress,
    abiText,
    explorerApi,
    selectedRpc,
  ]);

  useEffect(() => {
    if (!isExportModalOpen || !selectedExportTemplates.length) {
      console.log("[QR_EXPORT_EFFECT_IDLE]", {
        isExportModalOpen,
        selectedCount: selectedExportTemplates.length,
      });
      setExportQrDataUrl("");
      setExportQrError("");
      setExportQrHint("");
      setExportQrBusy(false);
      return undefined;
    }

    const qrPayloadText = JSON.stringify(buildQrTemplateExportPayload(selectedExportTemplates));

    let cancelled = false;
    setExportQrBusy(true);
    setExportQrDataUrl("");
    setExportQrError("");
    console.log("[QR_EXPORT_EFFECT_SELECTED_COUNT]", selectedExportTemplates.length);
    resolveQrExportText(qrPayloadText)
      .then(({ qrText, mode, payloadLength }) => {
        if (cancelled) return null;
        setExportQrHint(
          mode === "compressed"
            ? `二维码不包含 ABI，仅包含面板配置和已保存的方法参数。当前为压缩导入码，可在“JSON 文本导入”中粘贴导入。原始 JSON ${qrPayloadText.length} 字符，压缩载荷 ${payloadLength} 字符。`
            : `二维码不包含 ABI，仅包含面板配置和已保存的方法参数。当前二维码直接承载 JSON 文本，共 ${payloadLength} 字符。`
        );
        console.log("[QR_EXPORT_TEXT_MODE]", mode);
        console.log("[QR_EXPORT_LENGTH]", qrText.length);
        console.log("[QR_EXPORT_TEXT]", qrText);
        return withTimeout(
          QRCode.toString(qrText, {
            type: "svg",
            errorCorrectionLevel: "L",
            margin: 1,
            color: {
              dark: "#f7f3ec",
              light: "#121a2b",
            },
          }),
          4000,
          "二维码生成超时，请检查控制台输出的二维码文本。"
        );
      })
      .then((svgMarkup) => {
        if (cancelled || !svgMarkup) return;
        setExportQrDataUrl(svgToDataUrl(svgMarkup));
        setExportQrError("");
        setExportQrBusy(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setExportQrDataUrl("");
        setExportQrHint("");
        setExportQrError(`二维码生成失败：${error?.message || error}`);
        setExportQrBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isExportModalOpen, selectedExportTemplates]);

  const publicClient = useMemo(() => {
    if (!selectedRpc) return null;
    return createPublicClient({ transport: http(selectedRpc) });
  }, [selectedRpc]);

  const updateStatus = (message, type = "") => {
    setStatus({ message, type });
  };

  const clearLoadedContractState = (options = {}) => {
    const { clearDrafts = false } = options;
    setReadFns([]);
    setWriteFns([]);
    setProxyReadFns([]);
    setProxyWriteFns([]);
    setProxyInfo(null);
    setActiveScope("contract");
    if (clearDrafts) {
      setMethodDrafts({});
    }
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

  const fetchContractMetadata = async (addressValue) => {
    if (!explorerApi) {
      throw new Error("未提供浏览器 API 地址，无法读取合约元信息。");
    }

    const url = new URL(explorerApi);
    url.searchParams.set("module", "contract");
    url.searchParams.set("action", "getsourcecode");
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
      throw new Error(data.result || "合约元信息获取失败。请确认合约已验证。");
    }

    const [result] = Array.isArray(data.result) ? data.result : [];
    if (!result || typeof result !== "object") {
      throw new Error("浏览器 API 未返回有效合约元信息。");
    }

    return result;
  };

  const fetchContractAbi = async (addressValue) => {
    if (!explorerApi) {
      throw new Error("未提供浏览器 API 地址，无法读取 ABI。");
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
      throw new Error("浏览器 API ABI 请求失败。");
    }

    const data = await response.json();
    if (data.status !== "1") {
      throw new Error(data.result || "ABI 获取失败。请确认合约已验证。");
    }

    const abi = String(data.result || "").trim();
    if (!abi || abi === "Contract source code not verified") {
      throw new Error("未获取到有效 ABI。");
    }

    return abi;
  };

  const extractAbiFromMetadata = (metadata) => {
    const abi = String(metadata?.ABI || "").trim();
    if (!abi || abi === "Contract source code not verified") {
      return "";
    }
    return abi;
  };

  const parseImportedTemplatesFromText = (text) => {
    const parsed = JSON.parse(text);
    const templatesFromPayload = extractTemplateList(parsed)
      .map(sanitizeTemplate)
      .filter(Boolean);

    if (!templatesFromPayload.length) {
      throw new Error("未读取到有效模板。");
    }

    return templatesFromPayload;
  };

  const parseImportedTemplatesFromTextAsync = async (text) => {
    const normalizedText = await normalizeImportedText(text);
    return parseImportedTemplatesFromText(normalizedText);
  };

  const mergeImportedTemplates = (importedTemplates) => {
    if (!importedTemplates.length) {
      updateStatus("导入失败：未读取到有效模板。", "error");
      return { count: 0, insertedTemplates: [] };
    }

    const insertedTemplates = [];
    persistTemplates((prevTemplates) => {
      const usedIds = new Set(prevTemplates.map((item) => item.id));
      const nextTemplates = [...prevTemplates];

      importedTemplates.forEach((template) => {
        let nextId = template.id;
        while (usedIds.has(nextId)) {
          nextId = generateTemplateId();
        }
        usedIds.add(nextId);
        const nextTemplate = { ...template, id: nextId, updatedAt: getCurrentIsoTime() };
        insertedTemplates.push(nextTemplate);
        nextTemplates.push(nextTemplate);
      });

      return nextTemplates;
    });

    return {
      count: insertedTemplates.length,
      insertedTemplates,
    };
  };

  const downloadTextFile = (content, filename) => {
    const blob = new Blob([content], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
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
      let statusMessage = "";
      let contractMetadata = null;
      let metadataWarning = "";
      const manualAbi = abiText.trim();

      if (explorerApi) {
        try {
          contractMetadata = await fetchContractMetadata(contractAddress);
        } catch (error) {
          if (!manualAbi) {
            throw error;
          }
          metadataWarning = `已使用手填 ABI 加载，代理检测失败：${error?.message || error}`;
        }
      } else if (!manualAbi) {
        throw new Error("未填写 ABI 且未提供浏览器 API 地址。\n请粘贴 ABI 或填写 API 地址。");
      }

      let resolvedAbi = manualAbi;
      if (!resolvedAbi && explorerApi) {
        try {
          resolvedAbi = await fetchContractAbi(contractAddress);
        } catch {
          resolvedAbi = extractAbiFromMetadata(contractMetadata);
        }
      }

      if (!resolvedAbi) {
        throw new Error("未获取到 ABI。请粘贴 ABI，或确认合约已在浏览器中完成验证。");
      }

      if (!manualAbi) {
        setAbiText(resolvedAbi);
      }

      clearLoadedContractState();
      const functions = parseAbiTextToFunctions(resolvedAbi);
      setReadFns(functions.filter((fn) => isReadFunction(fn)));
      setWriteFns(functions.filter((fn) => !isReadFunction(fn)));

      const isProxyContract = parseExplorerProxyFlag(contractMetadata?.Proxy);
      const implementationAddress = getImplementationAddressFromMetadata(contractMetadata);

      if (isProxyContract && implementationAddress) {
        try {
          const implementationMetadata = await fetchContractMetadata(implementationAddress);
          let implementationAbiText = "";
          try {
            implementationAbiText = await fetchContractAbi(implementationAddress);
          } catch {
            implementationAbiText = extractAbiFromMetadata(implementationMetadata);
          }

          if (!implementationAbiText) {
            throw new Error("未能获取实现合约 ABI。");
          }

          let proxyFunctions = functions;
          const currentAbiNormalized = normalizeAbiText(resolvedAbi);
          const implementationAbiNormalized = normalizeAbiText(implementationAbiText);
          let abiNotice = "";

          if (currentAbiNormalized === implementationAbiNormalized) {
            const knownProxyFunctions = getKnownProxyFunctions(contractMetadata?.ContractName);
            if (knownProxyFunctions) {
              proxyFunctions = knownProxyFunctions;
              abiNotice =
                " 浏览器 API 返回的代理 ABI 与实现 ABI 相同，已回退为标准代理 ABI。";
            } else {
              abiNotice =
                " 浏览器 API 返回的代理 ABI 与实现 ABI 相同，当前合约方法可能仍然是实现 ABI。";
            }
          }

          setReadFns(proxyFunctions.filter((fn) => isReadFunction(fn)));
          setWriteFns(proxyFunctions.filter((fn) => !isReadFunction(fn)));

          const implementationFunctions = parseAbiTextToFunctions(implementationAbiText);
          setProxyReadFns(implementationFunctions.filter((fn) => isReadFunction(fn)));
          setProxyWriteFns(implementationFunctions.filter((fn) => !isReadFunction(fn)));
          setProxyInfo({
            implementationAddress,
            implementationName: String(implementationMetadata?.ContractName || "Implementation"),
            proxyName: String(contractMetadata?.ContractName || "Proxy"),
          });
          setActiveScope("proxy");
          statusMessage = `合约已加载完成，检测到代理实现：${implementationAddress}.${abiNotice}`;
        } catch (error) {
          statusMessage = `合约已加载完成，但代理实现加载失败：${error?.message || error}`;
        }
      } else {
        statusMessage = "合约已加载完成。";
      }

      if (metadataWarning) {
        updateStatus(`${statusMessage} ${metadataWarning}`, "success");
        return;
      }

      updateStatus(statusMessage, "success");
    } catch (error) {
      clearLoadedContractState();
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
    clearLoadedContractState();
    setMethodDrafts(cloneMethodStates(template.methodStates));
    setTemplateNameInput(template.name);
    setActiveTemplateId(template.id);
    setIsTemplateMenuOpen(false);
    setPendingTemplateContractReload(true);
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

  const handleCreateReusableTemplate = () => {
    if (!activeTemplateId) {
      updateStatus("请先选择一个已有模板，再执行复用新建。", "error");
      return;
    }

    const defaultName = `${activeTemplate?.name || "模板"}-new`;
    const promptedName = window.prompt("请输入新模板名称", defaultName) || "";
    const finalName = promptedName.trim();
    if (!finalName) {
      updateStatus("模板名称不能为空。", "error");
      return;
    }

    const now = getCurrentIsoTime();
    const nextTemplate = {
      id: generateTemplateId(),
      name: finalName,
      panel: buildReusablePanelValues(getCurrentPanelValues()),
      methodStates: {},
      createdAt: now,
      updatedAt: now,
    };

    persistTemplates((prevTemplates) => [...prevTemplates, nextTemplate]);
    applyPanelValues(nextTemplate.panel);
    clearLoadedContractState({ clearDrafts: true });
    setActiveTemplateId(nextTemplate.id);
    setTemplateNameInput(finalName);
    updateStatus(
      `已基于当前模板创建新模板：${finalName}。已保留网络配置，并清空合约地址、ABI 和方法参数。`,
      "success"
    );
  };

  const handleImportFiles = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";

    if (!files.length) return;

    setImportBusy(true);
    try {
      const importedTemplates = [];
      let invalidFiles = 0;

      for (const file of files) {
        try {
          const text = await file.text();
          importedTemplates.push(...(await parseImportedTemplatesFromTextAsync(text)));
        } catch {
          invalidFiles += 1;
        }
      }

      const { count: successCount } = mergeImportedTemplates(importedTemplates);
      if (!successCount) return;

      const invalidMessage = invalidFiles ? `，${invalidFiles} 个文件解析失败` : "";
      updateStatus(`成功导入 ${successCount} 个模板${invalidMessage}。`, "success");
      setIsImportModalOpen(false);
    } catch (error) {
      updateStatus(`导入失败：${error?.message || error}`, "error");
    } finally {
      setImportBusy(false);
    }
  };

  const handleImportJsonText = async () => {
    try {
      const importedTemplates = await parseImportedTemplatesFromTextAsync(importJsonText.trim());
      const { count: successCount } = mergeImportedTemplates(importedTemplates);
      if (!successCount) return;

      setImportJsonText("");
      setIsImportModalOpen(false);
      updateStatus(`成功导入 ${successCount} 个模板。`, "success");
    } catch (error) {
      updateStatus(`导入失败：${error?.message || error}`, "error");
    }
  };

  const handleImportFromUrl = async () => {
    const url = importUrl.trim();
    if (!url) {
      updateStatus("请输入可访问的 JSON URL。", "error");
      return;
    }

    setImportBusy(true);
    try {
      const embeddedTemplates = await parseImportedTemplatesFromTextAsync(url).catch(() => null);
      if (embeddedTemplates?.length) {
        const { count: successCount } = mergeImportedTemplates(embeddedTemplates);
        if (!successCount) return;

        setImportUrl("");
        setIsImportModalOpen(false);
        updateStatus(`成功导入 ${successCount} 个模板。`, "success");
        return;
      }

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error("URL 请求失败。请检查地址和跨域设置。");
      }

      const text = await response.text();
      const importedTemplates = await parseImportedTemplatesFromTextAsync(text);
      const { count: successCount } = mergeImportedTemplates(importedTemplates);
      if (!successCount) return;

      setImportUrl("");
      setIsImportModalOpen(false);
      updateStatus(`成功导入 ${successCount} 个模板。`, "success");
    } catch (error) {
      updateStatus(`导入失败：${error?.message || error}`, "error");
    } finally {
      setImportBusy(false);
    }
  };

  const openImportModal = () => {
    setImportMode("file");
    setImportJsonText("");
    setImportUrl("");
    setIsImportModalOpen(true);
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
    setExportSelection((prev) => {
      const nextSelection = {
        ...prev,
        [templateId]: !prev[templateId],
      };
      console.log("[QR_EXPORT_SELECTION]", nextSelection);
      return nextSelection;
    });
  };

  const handleToggleExportAll = () => {
    const allChecked =
      templates.length > 0 && templates.every((template) => exportSelection[template.id]);

    const nextSelection = {};
    templates.forEach((template) => {
      nextSelection[template.id] = !allChecked;
    });
    console.log("[QR_EXPORT_SELECTION]", nextSelection);
    setExportSelection(nextSelection);
  };

  const handleConfirmExport = () => {
    const selectedTemplates = templates.filter((template) => exportSelection[template.id]);

    if (!selectedTemplates.length) {
      updateStatus("请至少选择一个模板进行导出。", "error");
      return;
    }

    const payload = buildTemplateExportPayload(selectedTemplates);
    downloadTextFile(
      JSON.stringify(payload, null, 2),
      `contract-templates-${Date.now()}.json`
    );
    updateStatus(`已导出 ${selectedTemplates.length} 个模板。`, "success");
  };

  const handleCopyExportText = async () => {
    if (!selectedExportTemplates.length) {
      updateStatus("请先选择要导出的模板。", "error");
      return;
    }

    try {
      const rawExportText = JSON.stringify(buildTemplateExportPayload(selectedExportTemplates));
      await navigator.clipboard.writeText(rawExportText);
      setExportCopySuccess(true);
      updateStatus("导出 JSON 已复制到剪贴板。", "success");
    } catch (error) {
      setExportCopySuccess(false);
      updateStatus(`复制失败：${error?.message || error}`, "error");
    }
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
    clearLoadedContractState({ clearDrafts: true });
    setMethodDrafts({});
    updateStatus("已清空。", "");
  };

  const hasProxyView = proxyReadFns.length > 0 || proxyWriteFns.length > 0;
  const activeList =
    activeScope === "proxy"
      ? activeTab === "read"
        ? proxyReadFns
        : proxyWriteFns
      : activeTab === "read"
        ? readFns
        : writeFns;
  const emptyText =
    activeScope === "proxy"
      ? activeTab === "read"
        ? "未读取到代理实现的只读方法。"
        : "未读取到代理实现的可写方法。"
      : activeTab === "read"
        ? "请先加载合约。"
        : "加载合约后，这里会展示可写方法。";

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
                  <input
                    className="template-search"
                    type="text"
                    value={templateSearchText}
                    placeholder="搜索模板"
                    onChange={(event) => setTemplateSearchText(event.target.value)}
                  />

                  {sortedTemplates.length === 0 ? (
                    <div className="template-empty">暂无模板</div>
                  ) : filteredTemplateOptions.length === 0 ? (
                    <div className="template-empty">暂无匹配模板</div>
                  ) : (
                    filteredTemplateOptions.map((template) => (
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
              onClick={openImportModal}
            >
              导入
            </button>
            <button className="btn ghost small-btn" type="button" onClick={openExportModal}>
              导出
            </button>
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
            <button
              className="btn secondary"
              onClick={handleCreateReusableTemplate}
              disabled={!activeTemplateId}
              title={activeTemplateId ? "基于当前模板快速新建" : "请先选择一个已有模板"}
            >
              复用新建
            </button>
            <button className="btn ghost" onClick={resetAll}>
              清空
            </button>
          </div>

          <div className={`status ${status.type}`}>{status.message}</div>
        </section>

        <section className="content">
          {hasProxyView && (
            <div className="proxy-banner">
              <div>
                <strong>已检测到代理合约</strong>
                <span className="proxy-meta">
                  合约类型：{proxyInfo?.proxyName || "Proxy"} {"->"}{" "}
                  {proxyInfo?.implementationName || "Implementation"}
                </span>
                <span className="proxy-meta">
                  当前地址：{contractAddress}
                </span>
                <span className="proxy-meta">
                  实现地址：{proxyInfo?.implementationAddress}
                </span>
              </div>
              {proxyInfo?.implementationAddress && explorerBase && (
                <a
                  className="btn ghost tiny-btn"
                  href={buildExplorerAddressUrl(explorerBase, proxyInfo.implementationAddress)}
                  target="_blank"
                  rel="noopener"
                >
                  查看实现合约
                </a>
              )}
            </div>
          )}

          {hasProxyView && (
            <div className="scope-tabs">
              <button
                className={`tab ${activeScope === "contract" ? "active" : ""}`}
                onClick={() => setActiveScope("contract")}
              >
                当前合约
              </button>
              <button
                className={`tab ${activeScope === "proxy" ? "active" : ""}`}
                onClick={() => setActiveScope("proxy")}
              >
                代理实现
              </button>
            </div>
          )}

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
            <h2>
              {activeScope === "proxy"
                ? activeTab === "read"
                  ? "Read As Proxy"
                  : "Write As Proxy"
                : activeTab === "read"
                  ? "Read 方法"
                  : "Write 方法"}
            </h2>
            <span className="pill">{activeList.length}</span>
          </div>

          <div className={`method-list ${activeList.length ? "" : "empty"}`}>
            {activeList.length === 0
              ? emptyText
              : activeList.map((fn) => {
                  const methodStorageKey = buildScopedMethodStorageKey(
                    activeScope,
                    activeTab,
                    fn
                  );
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

      {isImportModalOpen && (
        <div className="modal-overlay">
          <div className="modal-card modal-wide">
            <h3>导入模板</h3>

            <div className="modal-tab-row">
              <button
                className={`tab ${importMode === "file" ? "active" : ""}`}
                type="button"
                onClick={() => setImportMode("file")}
              >
                文件导入
              </button>
              <button
                className={`tab ${importMode === "text" ? "active" : ""}`}
                type="button"
                onClick={() => setImportMode("text")}
              >
                JSON 文本
              </button>
              <button
                className={`tab ${importMode === "url" ? "active" : ""}`}
                type="button"
                onClick={() => setImportMode("url")}
              >
                在线 URL
              </button>
            </div>

            {importMode === "file" && (
              <div className="import-panel">
                <label className="field">
                  <span>选择一个或多个 JSON 文件</span>
                  <input
                    type="file"
                    accept="application/json,.json"
                    multiple
                    onChange={handleImportFiles}
                    disabled={importBusy}
                  />
                </label>
                <div className="modal-help">支持批量导入，文件内容可为单模板或模板数组。</div>
              </div>
            )}

            {importMode === "text" && (
              <div className="import-panel">
                <label className="field">
                  <span>粘贴 JSON 文本</span>
                  <textarea
                    rows={14}
                    value={importJsonText}
                    placeholder='{"version":1,"templates":[...]} 或 CECD1:xxxxx'
                    onChange={(event) => setImportJsonText(event.target.value)}
                  ></textarea>
                </label>
                <div className="modal-help">支持标准 JSON，也支持粘贴二维码扫描得到的压缩导入码。</div>
                <div className="actions">
                  <button
                    className="btn primary"
                    type="button"
                    onClick={handleImportJsonText}
                    disabled={!importJsonText.trim()}
                  >
                    导入文本
                  </button>
                </div>
              </div>
            )}

            {importMode === "url" && (
              <div className="import-panel">
                <label className="field">
                  <span>输入在线 JSON 地址</span>
                  <input
                    type="text"
                    value={importUrl}
                    placeholder="https://example.com/templates.json"
                    onChange={(event) => setImportUrl(event.target.value)}
                  />
                </label>
                <div className="modal-help">URL 需支持浏览器直接访问，若目标站点未开启 CORS，会导入失败。</div>
                <div className="actions">
                  <button
                    className="btn primary"
                    type="button"
                    onClick={handleImportFromUrl}
                    disabled={importBusy || !importUrl.trim()}
                  >
                    {importBusy ? "导入中..." : "从 URL 导入"}
                  </button>
                </div>
              </div>
            )}

            <div className="actions">
              <button
                className="btn ghost"
                type="button"
                onClick={() => setIsImportModalOpen(false)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {isExportModalOpen && (
        <div className="modal-overlay">
          <div className="modal-card modal-wide">
            <h3>导出模板</h3>

            <div className="export-layout">
              <div className="export-sidebar">
                <button className="link-btn" type="button" onClick={handleToggleExportAll}>
                  全部选择 / 取消全选
                </button>

                <div className="export-list">
                  {sortedTemplates.map((template) => (
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
              </div>

              <div className="export-preview">
                <label className="field">
                  <span>JSON 预览</span>
                  <textarea
                    rows={16}
                    value={exportPreviewText}
                    readOnly
                    placeholder="选择模板后，这里会显示导出 JSON。"
                  ></textarea>
                </label>

                <div className="actions">
                  <button className="btn secondary" type="button" onClick={handleCopyExportText}>
                    {exportCopySuccess ? "已复制" : "复制 JSON"}
                  </button>
                  <button className="btn primary" type="button" onClick={handleConfirmExport}>
                    导出选中
                  </button>
                </div>
                {exportCopySuccess ? (
                  <div className="inline-feedback success">JSON 文本已复制到剪贴板。</div>
                ) : null}

                <div className="qr-panel">
                  <div className="qr-panel-title">二维码</div>
                  {exportQrHint ? <div className="qr-panel-hint">{exportQrHint}</div> : null}
                  {exportQrDataUrl ? (
                    <img className="qr-image" src={exportQrDataUrl} alt="export json qr" />
                  ) : (
                    <div className="qr-placeholder">
                      {exportQrBusy
                        ? "二维码生成中..."
                        : exportQrError || "选择模板后可生成二维码。"}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="actions">
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
