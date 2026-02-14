import React, { useEffect, useMemo, useRef, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useWalletClient } from "wagmi";
import {
  createPublicClient,
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
  const combined = `${whole}${fraction}`;
  return BigInt(combined);
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

function normalizeMethodState(raw, inputLength) {
  const safeRaw = raw && typeof raw === "object" ? raw : {};
  const params = Array.isArray(safeRaw.params)
    ? safeRaw.params.slice(0, inputLength).map((item) => String(item ?? ""))
    : [];
  const exponents = Array.isArray(safeRaw.exponents)
    ? safeRaw.exponents
        .slice(0, inputLength)
        .map((item) => Number(item || 0))
        .map((item) => (Number.isNaN(item) ? 0 : item))
    : [];

  while (params.length < inputLength) params.push("");
  while (exponents.length < inputLength) exponents.push(0);

  return {
    params,
    exponents,
    payableValue: String(safeRaw.payableValue ?? ""),
  };
}

function sanitizeMethodStates(raw) {
  if (!raw || typeof raw !== "object") return {};
  const next = {};
  Object.entries(raw).forEach(([key, value]) => {
    if (!value || typeof value !== "object") return;
    const params = Array.isArray(value.params)
      ? value.params.map((item) => String(item ?? ""))
      : [];
    const exponents = Array.isArray(value.exponents)
      ? value.exponents
          .map((item) => Number(item || 0))
          .map((item) => (Number.isNaN(item) ? 0 : item))
      : [];
    next[key] = {
      params,
      exponents,
      payableValue: String(value.payableValue ?? ""),
    };
  });
  return next;
}

function cloneMethodStates(methodStates) {
  return JSON.parse(JSON.stringify(methodStates || {}));
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
    const list = extractTemplateList(parsed)
      .map(sanitizeTemplate)
      .filter(Boolean);
    return list;
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
  const inputLength = fn.inputs?.length || 0;
  const normalizedSavedCallState = useMemo(
    () => normalizeMethodState(savedCallState, inputLength),
    [savedCallState, inputLength]
  );

  const [params, setParams] = useState(normalizedSavedCallState.params);
  const [exponents, setExponents] = useState(normalizedSavedCallState.exponents);
  const [payableValue, setPayableValue] = useState(
    normalizedSavedCallState.payableValue
  );
  const [output, setOutput] = useState(
    kind === "read" ? "调用结果将在此显示" : "交易状态将在此显示"
  );
  const [txHash, setTxHash] = useState("");
  const [loading, setLoading] = useState(false);
  const signature = getFunctionSignature(fn);

  useEffect(() => {
    setParams(normalizedSavedCallState.params);
    setExponents(normalizedSavedCallState.exponents);
    setPayableValue(normalizedSavedCallState.payableValue);
  }, [normalizedSavedCallState]);

  const persistCurrentInputs = () => {
    onPersist(methodStorageKey, {
      params: [...params],
      exponents: [...exponents],
      payableValue,
    });
  };

  const handleParamChange = (index, value) => {
    setParams((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const handleExponentChange = (index, value) => {
    setExponents((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const handleCall = async () => {
    persistCurrentInputs();
    setLoading(true);
    setOutput(kind === "read" ? "正在调用..." : "正在发送交易...");
    setTxHash("");

    try {
      const parsedArgs = (fn.inputs || []).map((input, index) => {
        const rawValue = params[index] || "";
        if (SCALE_TYPES.has(input.type)) {
          const exponent = Number(exponents[index] || 0);
          if (exponent > 0) {
            return parseDecimalWithExponent(rawValue, exponent);
          }
          if (rawValue.includes(".")) {
            throw new Error("uint 类型不支持小数，请选择 10^n 或改用整数。");
          }
          return parseInputValue(rawValue, input.type);
        }
        return parseInputValue(rawValue, input.type);
      });

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
        {fn.inputs?.length > 0 && (
          <div className="param-grid">
            {fn.inputs.map((input, index) => (
              <div className="param" key={`${input.name}-${index}`}>
                <label>
                  {input.name || `arg${index}`} ({input.type})
                </label>
                {SCALE_TYPES.has(input.type) ? (
                  <div className="input-with-addon">
                    <input
                      type="text"
                      placeholder={
                        input.type.includes("[]") || input.type.startsWith("tuple")
                          ? "JSON 格式"
                          : "输入参数"
                      }
                      value={params[index]}
                      onChange={(event) =>
                        handleParamChange(index, event.target.value)
                      }
                    />
                    <select
                      className="addon-select"
                      value={exponents[index]}
                      onChange={(event) =>
                        handleExponentChange(index, Number(event.target.value))
                      }
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
                      input.type.includes("[]") || input.type.startsWith("tuple")
                        ? "JSON 格式"
                        : "输入参数"
                    }
                    value={params[index]}
                    onChange={(event) =>
                      handleParamChange(index, event.target.value)
                    }
                  />
                )}
              </div>
            ))}
          </div>
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
  const [abi, setAbi] = useState(null);
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

  const { isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();

  const templateMenuRef = useRef(null);
  const importInputRef = useRef(null);

  const rpcOptions = useMemo(() => parseRpcList(rpcListText), [rpcListText]);
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

  const fetchAbiFromExplorer = async (address) => {
    if (!explorerApi) {
      throw new Error("未填写 ABI 且未提供浏览器 API 地址。\n请粘贴 ABI 或填写 API 地址。");
    }
    const url = new URL(explorerApi);
    url.searchParams.set("module", "contract");
    url.searchParams.set("action", "getabi");
    url.searchParams.set("address", address);
    if (explorerApiKey) {
      url.searchParams.set("apikey", explorerApiKey);
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
      const decoded = decodeFunctionResult({
        abi: [fn],
        functionName: fn.name,
        data: raw,
      });
      return decoded;
    } catch (proxyError) {
      const rpcMessage = rpcError?.message || rpcError;
      const proxyMessage = proxyError?.message || proxyError;
      throw new Error(
        `RPC 调用失败（已重试 3 次）：${rpcMessage}\n浏览器 API 代理调用失败：${proxyMessage}`
      );
    }
  };

  const handleWrite = async (fn, args, valueEth) => {
    if (!walletClient || !isConnected) {
      throw new Error("请先连接钱包。");
    }
    if (!publicClient) {
      throw new Error("请先填写 RPC 端点。\n或确保 RPC 列表已选中。");
    }

    const value = valueEth?.trim() ? parseEther(valueEth.trim()) : undefined;
    const hash = await walletClient.writeContract({
      address: contractAddress,
      abi: [fn],
      functionName: fn.name,
      args,
      value,
      account: walletClient.account,
    });

    const receiptPromise = publicClient
      ? publicClient.waitForTransactionReceipt({ hash })
      : Promise.resolve(null);

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

      setAbi(parsed);
      const functions = parsed.filter((item) => item.type === "function");
      const reads = functions.filter((fn) => isReadFunction(fn));
      const writes = functions.filter((fn) => !isReadFunction(fn));

      setReadFns(reads);
      setWriteFns(writes);
      updateStatus("合约已加载完成。", "success");
    } catch (error) {
      updateStatus(`加载失败：${error?.message || error}`, "error");
    }
  };

  const handlePersistMethodState = (methodKey, nextState) => {
    const safeState = {
      params: Array.isArray(nextState?.params)
        ? nextState.params.map((item) => String(item ?? ""))
        : [],
      exponents: Array.isArray(nextState?.exponents)
        ? nextState.exponents
            .map((item) => Number(item || 0))
            .map((item) => (Number.isNaN(item) ? 0 : item))
        : [],
      payableValue: String(nextState?.payableValue ?? ""),
    };

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
    const currentPanel = getCurrentPanelValues();
    const now = getCurrentIsoTime();

    if (activeTemplate) {
      const nextName = templateNameInput.trim() || activeTemplate.name;
      persistTemplates((prevTemplates) =>
        prevTemplates.map((item) => {
          if (item.id !== activeTemplate.id) return item;
          return {
            ...item,
            name: nextName,
            panel: currentPanel,
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
    const name = nameFromInput || window.prompt("请输入模板名称") || "";
    const finalName = name.trim();
    if (!finalName) {
      updateStatus("模板名称不能为空。", "error");
      return;
    }

    const nextTemplate = {
      id: generateTemplateId(),
      name: finalName,
      panel: currentPanel,
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
        const sanitized = list.map(sanitizeTemplate).filter(Boolean);
        importedTemplates.push(...sanitized);
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

    const invalidMessage = invalidFiles
      ? `，${invalidFiles} 个文件解析失败`
      : "";
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
    const allChecked = templates.length > 0 &&
      templates.every((template) => exportSelection[template.id]);

    const nextSelection = {};
    templates.forEach((template) => {
      nextSelection[template.id] = !allChecked;
    });
    setExportSelection(nextSelection);
  };

  const handleConfirmExport = () => {
    const selectedTemplates = templates.filter(
      (template) => exportSelection[template.id]
    );

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
    const filename = `contract-templates-${Date.now()}.json`;
    link.href = url;
    link.download = filename;
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
    setAbi(null);
    setReadFns([]);
    setWriteFns([]);
    setMethodDrafts({});
    updateStatus("已清空。", "");
  };

  const activeList = activeTab === "read" ? readFns : writeFns;
  const emptyText =
    activeTab === "read"
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
            <button
              className="btn ghost small-btn"
              type="button"
              onClick={openExportModal}
            >
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
            <select
              value={selectedRpc}
              onChange={(event) => setSelectedRpc(event.target.value)}
            >
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
              <span>链 ID（用于展示/切链提示）</span>
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
