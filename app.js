/* global ethers */

const rpcList = document.getElementById("rpcList");
const rpcSelect = document.getElementById("rpcSelect");
const explorerBase = document.getElementById("explorerBase");
const explorerApi = document.getElementById("explorerApi");
const explorerApiKey = document.getElementById("explorerApiKey");
const contractAddressInput = document.getElementById("contractAddress");
const contractAbiInput = document.getElementById("contractAbi");
const chainIdInput = document.getElementById("chainId");
const loadContractBtn = document.getElementById("loadContract");
const resetAllBtn = document.getElementById("resetAll");
const statusEl = document.getElementById("status");
const readList = document.getElementById("readList");
const writeList = document.getElementById("writeList");
const readCount = document.getElementById("readCount");
const writeCount = document.getElementById("writeCount");
const walletIndicator = document.getElementById("walletIndicator");
const walletText = document.getElementById("walletText");
const connectWalletBtn = document.getElementById("connectWallet");
const walletTypeSelect = document.getElementById("walletType");
const walletConnectProjectIdInput = document.getElementById("walletConnectProjectId");

let currentAbi = null;
let readContract = null;
let writeContract = null;
let browserProvider = null;
let connectedAccount = null;
let cachedProvider = null;
let cachedProviderKey = "";
let walletConnectModule = null;
let activeWalletLabel = "";

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = "status" + (type ? ` ${type}` : "");
}

function shortAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function setWalletDisplay(label, address) {
  walletIndicator.classList.add("online");
  walletText.textContent = label ? `${label} · ${shortAddress(address)}` : shortAddress(address);
}

function parseRpcList() {
  return rpcList.value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function refreshRpcSelect() {
  const items = parseRpcList();
  rpcSelect.innerHTML = "";
  if (items.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "请先填写 RPC";
    rpcSelect.appendChild(option);
    return;
  }

  items.forEach((rpc, index) => {
    const option = document.createElement("option");
    option.value = rpc;
    option.textContent = `${index + 1}. ${rpc}`;
    rpcSelect.appendChild(option);
  });
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

function createParamInput(param, index) {
  const wrapper = document.createElement("div");
  wrapper.className = "param";

  const label = document.createElement("label");
  const name = param.name || `arg${index}`;
  label.textContent = `${name} (${param.type})`;

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = param.type.includes("[]") || param.type.startsWith("tuple")
    ? "JSON 格式"
    : "输入参数";
  input.dataset.paramType = param.type;
  input.dataset.paramName = name;

  wrapper.appendChild(label);
  wrapper.appendChild(input);
  return wrapper;
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

function getFunctionSignature(fn) {
  const types = (fn.inputs || []).map((input) => input.type).join(",");
  return `${fn.name}(${types})`;
}

function isReadFunction(fn) {
  return fn.stateMutability === "view" || fn.stateMutability === "pure" || fn.constant === true;
}

function getChainIdNumber() {
  const raw = chainIdInput.value.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error("链 ID 格式不正确，请填写正整数。");
  }
  return parsed;
}

function getReadProvider() {
  const rpcUrl = rpcSelect.value;
  if (!rpcUrl) return null;

  const desiredChainId = chainIdInput.value.trim();
  const key = `${rpcUrl}::${desiredChainId || "auto"}`;
  if (cachedProvider && cachedProviderKey === key) {
    return cachedProvider;
  }

  const network = desiredChainId
    ? { chainId: Number(desiredChainId), name: "custom" }
    : undefined;

  cachedProvider = new ethers.JsonRpcProvider(rpcUrl, network);
  cachedProviderKey = key;
  return cachedProvider;
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

async function proxyEthCall({ to, data }) {
  const apiBase = explorerApi.value.trim();
  if (!apiBase) {
    throw new Error("未配置浏览器 API 地址，无法使用 RPC 代理调用。");
  }

  const apiKey = explorerApiKey.value.trim();
  const url = new URL(apiBase);
  url.searchParams.set("module", "proxy");
  url.searchParams.set("action", "eth_call");
  url.searchParams.set("to", to);
  url.searchParams.set("data", data);
  url.searchParams.set("tag", "latest");
  if (apiKey) {
    url.searchParams.set("apikey", apiKey);
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
}

async function callReadWithFallback(fn, params) {
  const signature = getFunctionSignature(fn);
  let rpcError;
  try {
    if (!readContract) {
      throw new Error("未创建 RPC Provider。");
    }
    return await retryCall(() => readContract[signature](...params), 3);
  } catch (error) {
    rpcError = error;
  }

  try {
    const iface = new ethers.Interface(currentAbi);
    const data = iface.encodeFunctionData(signature, params);
    const raw = await proxyEthCall({
      to: contractAddressInput.value.trim(),
      data,
    });
    const decoded = iface.decodeFunctionResult(signature, raw);
    if (decoded.length === 1) {
      return decoded[0];
    }
    return decoded;
  } catch (proxyError) {
    const rpcMessage = rpcError?.message || rpcError;
    const proxyMessage = proxyError?.message || proxyError;
    throw new Error(
      `RPC 调用失败（已重试 3 次）：${rpcMessage}\n浏览器 API 代理调用失败：${proxyMessage}`
    );
  }
}

function pickInjectedProvider(type) {
  const injected = window.ethereum;

  if (type === "okx") {
    if (window.okxwallet?.request) {
      return window.okxwallet;
    }
    if (injected?.providers?.length) {
      const okxProvider = injected.providers.find((provider) => provider.isOkxWallet);
      if (okxProvider) return okxProvider;
    }
    if (injected?.isOkxWallet) {
      return injected;
    }
    return null;
  }

  if (injected?.providers?.length) {
    const metaMask = injected.providers.find((provider) => provider.isMetaMask);
    if (metaMask) return metaMask;
  }

  return injected || null;
}

async function connectInjected(provider, label) {
  if (!provider?.request) {
    throw new Error("未检测到钱包插件。");
  }

  const desiredChainId = chainIdInput.value.trim();
  if (desiredChainId) {
    const hexChainId = "0x" + Number(desiredChainId).toString(16);
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexChainId }],
    });
  }

  await provider.request({ method: "eth_requestAccounts" });
  browserProvider = new ethers.BrowserProvider(provider);
  const signer = await browserProvider.getSigner();
  connectedAccount = await signer.getAddress();
  activeWalletLabel = label;
  setWalletDisplay(label, connectedAccount);

  const address = contractAddressInput.value.trim();
  if (currentAbi && address) {
    writeContract = new ethers.Contract(address, currentAbi, signer);
  }
  setStatus("钱包已连接。", "success");
}

async function loadWalletConnectModule() {
  if (walletConnectModule) return walletConnectModule;
  walletConnectModule = await import(
    "https://unpkg.com/@walletconnect/ethereum-provider@2.12.2/dist/index.es.js"
  );
  return walletConnectModule;
}

async function connectWalletConnect() {
  const projectId = walletConnectProjectIdInput.value.trim();
  if (!projectId) {
    throw new Error("请填写 WalletConnect Project ID。");
  }

  const chainId = getChainIdNumber();
  const rpcUrl = rpcSelect.value;
  const rpcMap = {};
  if (chainId && rpcUrl) {
    rpcMap[chainId] = rpcUrl;
  }

  const module = await loadWalletConnectModule();
  const EthereumProvider = module.EthereumProvider || module.default || module;
  if (!EthereumProvider?.init) {
    throw new Error("WalletConnect 初始化失败，请检查网络或依赖加载。");
  }

  const metadataUrl = window.location.origin === "null" ? "https://localhost" : window.location.origin;
  const wcProvider = await EthereumProvider.init({
    projectId,
    showQrModal: true,
    optionalChains: chainId ? [chainId] : undefined,
    rpcMap: Object.keys(rpcMap).length ? rpcMap : undefined,
    metadata: {
      name: "Common EVM Contract Dashboard",
      description: "通用 EVM 合约查看与调用面板",
      url: metadataUrl,
      icons: [],
    },
  });

  if (typeof wcProvider.enable === "function") {
    await wcProvider.enable();
  } else if (typeof wcProvider.connect === "function") {
    await wcProvider.connect();
  } else {
    await wcProvider.request({ method: "eth_requestAccounts" });
  }

  browserProvider = new ethers.BrowserProvider(wcProvider);
  const signer = await browserProvider.getSigner();
  connectedAccount = await signer.getAddress();
  activeWalletLabel = "WalletConnect";
  setWalletDisplay(activeWalletLabel, connectedAccount);

  const address = contractAddressInput.value.trim();
  if (currentAbi && address) {
    writeContract = new ethers.Contract(address, currentAbi, signer);
  }
  setStatus("WalletConnect 已连接。", "success");
}

function buildMethodCard(fn, kind) {
  const signature = getFunctionSignature(fn);
  const details = document.createElement("details");
  details.className = "method-card";
  details.open = false;

  const summary = document.createElement("summary");
  const title = document.createElement("div");
  title.textContent = fn.name;
  const meta = document.createElement("span");
  meta.className = "method-meta";
  meta.textContent = signature;
  summary.appendChild(title);
  summary.appendChild(meta);

  const body = document.createElement("div");
  body.className = "method-body";

  const paramGrid = document.createElement("div");
  paramGrid.className = "param-grid";

  (fn.inputs || []).forEach((param, index) => {
    paramGrid.appendChild(createParamInput(param, index));
  });

  if ((fn.inputs || []).length > 0) {
    body.appendChild(paramGrid);
  }

  if (kind === "write" && fn.stateMutability === "payable") {
    const valueWrapper = document.createElement("div");
    valueWrapper.className = "param";
    const label = document.createElement("label");
    label.textContent = "Value (ETH)";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "0.0";
    input.dataset.paramType = "__value__";
    valueWrapper.appendChild(label);
    valueWrapper.appendChild(input);
    body.appendChild(valueWrapper);
  }

  const actionRow = document.createElement("div");
  actionRow.className = "actions";

  const actionBtn = document.createElement("button");
  actionBtn.className = "btn secondary";
  actionBtn.textContent = kind === "read" ? "调用" : "发起交易";
  actionRow.appendChild(actionBtn);

  const output = document.createElement("div");
  output.className = "output";
  output.textContent = kind === "read" ? "调用结果将在此显示" : "交易状态将在此显示";

  body.appendChild(actionRow);
  body.appendChild(output);

  if (kind === "write") {
    const txRow = document.createElement("div");
    txRow.className = "tx-row";
    const txHash = document.createElement("span");
    txHash.className = "tx-hash";
    const viewBtn = document.createElement("a");
    viewBtn.className = "btn ghost";
    viewBtn.textContent = "查看交易";
    viewBtn.target = "_blank";
    viewBtn.rel = "noopener";
    viewBtn.style.display = "none";
    txRow.appendChild(txHash);
    txRow.appendChild(viewBtn);
    body.appendChild(txRow);

    actionBtn.addEventListener("click", async () => {
      if (!writeContract) {
        output.textContent = "请先连接钱包。";
        return;
      }
      actionBtn.disabled = true;
      output.textContent = "正在发送交易...";
      txHash.textContent = "";
      viewBtn.style.display = "none";

      try {
        const params = collectParams(paramGrid);
        const overrides = {};
        const valueInput = body.querySelector("input[data-param-type='__value__']");
        if (valueInput && valueInput.value.trim()) {
          overrides.value = ethers.parseEther(valueInput.value.trim());
        }

        const tx = await writeContract[signature](...params, overrides);
        output.textContent = "交易已发送，等待钱包确认...";
        txHash.textContent = tx.hash;
        const base = explorerBase.value.trim();
        if (base) {
          viewBtn.href = `${base.replace(/\/$/, "")}/tx/${tx.hash}`;
          viewBtn.style.display = "inline-flex";
        }
        const receipt = await tx.wait();
        output.textContent = receipt && receipt.status === 1
          ? "交易已确认成功。"
          : "交易已确认，但可能失败。";
      } catch (error) {
        output.textContent = `交易失败：${error?.message || error}`;
      } finally {
        actionBtn.disabled = false;
      }
    });
  } else {
    actionBtn.addEventListener("click", async () => {
      if (!readContract) {
        output.textContent = "请先加载合约。";
        return;
      }
      actionBtn.disabled = true;
      output.textContent = "正在调用...";
      try {
        const params = collectParams(paramGrid);
        const result = await callReadWithFallback(fn, params);
        output.textContent = stringifyResult(result);
      } catch (error) {
        output.textContent = `调用失败：${error?.message || error}`;
      } finally {
        actionBtn.disabled = false;
      }
    });
  }

  details.appendChild(summary);
  details.appendChild(body);
  return details;
}

function collectParams(container) {
  if (!container) return [];
  const inputs = Array.from(container.querySelectorAll("input"));
  return inputs.map((input) => parseInputValue(input.value, input.dataset.paramType));
}

function buildMethodLists() {
  const functions = currentAbi.filter((item) => item.type === "function");
  const reads = functions.filter((fn) => isReadFunction(fn));
  const writes = functions.filter((fn) => !isReadFunction(fn));

  readList.innerHTML = "";
  writeList.innerHTML = "";

  reads.forEach((fn) => readList.appendChild(buildMethodCard(fn, "read")));
  writes.forEach((fn) => writeList.appendChild(buildMethodCard(fn, "write")));

  readCount.textContent = `${reads.length}`;
  writeCount.textContent = `${writes.length}`;

  if (reads.length === 0) {
    readList.textContent = "未找到可读方法。";
    readList.classList.add("empty");
  } else {
    readList.classList.remove("empty");
  }

  if (writes.length === 0) {
    writeList.textContent = "未找到可写方法。";
    writeList.classList.add("empty");
  } else {
    writeList.classList.remove("empty");
  }
}

async function fetchAbiFromExplorer(address) {
  const apiBase = explorerApi.value.trim();
  if (!apiBase) {
    throw new Error("未填写 ABI 且未提供浏览器 API 地址。\n请粘贴 ABI 或填写 API 地址。");
  }

  const apiKey = explorerApiKey.value.trim();
  const url = new URL(apiBase);
  url.searchParams.set("module", "contract");
  url.searchParams.set("action", "getabi");
  url.searchParams.set("address", address);
  if (apiKey) {
    url.searchParams.set("apikey", apiKey);
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
}

async function loadContract() {
  setStatus("", "");
  refreshRpcSelect();

  const rpcUrl = rpcSelect.value;
  if (!rpcUrl) {
    setStatus("请先填写 RPC 端点。", "error");
    return;
  }

  const address = contractAddressInput.value.trim();
  if (!address) {
    setStatus("请填写合约地址。", "error");
    return;
  }

  try {
    let abiText = contractAbiInput.value.trim();
    if (!abiText) {
      setStatus("正在通过浏览器 API 拉取 ABI...", "");
      abiText = await fetchAbiFromExplorer(address);
      contractAbiInput.value = abiText;
    }

    currentAbi = JSON.parse(abiText);
    const provider = getReadProvider();
    if (!provider) {
      throw new Error("请先填写 RPC 端点。");
    }
    readContract = new ethers.Contract(address, currentAbi, provider);

    if (browserProvider && connectedAccount) {
      const signer = await browserProvider.getSigner();
      writeContract = new ethers.Contract(address, currentAbi, signer);
    } else {
      writeContract = null;
    }

    buildMethodLists();
    setStatus("合约已加载完成。", "success");
  } catch (error) {
    setStatus(`加载失败：${error?.message || error}`, "error");
  }
}

async function connectWallet() {
  try {
    const walletType = walletTypeSelect?.value || "injected";
    if (walletType === "walletconnect") {
      await connectWalletConnect();
      return;
    }

    const provider = pickInjectedProvider(walletType);
    if (!provider) {
      const tip = walletType === "okx" ? "未检测到 OKX Web3 钱包。" : "未检测到钱包插件（如 MetaMask）。";
      throw new Error(tip);
    }

    const label = walletType === "okx" ? "OKX Wallet" : "Injected";
    await connectInjected(provider, label);
  } catch (error) {
    setStatus(`连接钱包失败：${error?.message || error}`, "error");
  }
}

function resetAll() {
  rpcList.value = "";
  contractAddressInput.value = "";
  contractAbiInput.value = "";
  explorerBase.value = "";
  explorerApi.value = "";
  explorerApiKey.value = "";
  chainIdInput.value = "";
  readList.textContent = "请先加载合约。";
  writeList.textContent = "加载合约后，这里会展示可写方法。";
  readList.classList.add("empty");
  writeList.classList.add("empty");
  readCount.textContent = "0";
  writeCount.textContent = "0";
  currentAbi = null;
  readContract = null;
  writeContract = null;
  cachedProvider = null;
  cachedProviderKey = "";
  setStatus("已清空。", "");
  refreshRpcSelect();
}

rpcList.addEventListener("input", refreshRpcSelect);
loadContractBtn.addEventListener("click", loadContract);
connectWalletBtn.addEventListener("click", connectWallet);
resetAllBtn.addEventListener("click", resetAll);

refreshRpcSelect();
