import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@rainbow-me/rainbowkit", () => ({
  ConnectButton: {
    Custom: ({ children }) =>
      children({
        account: undefined,
        chain: undefined,
        mounted: true,
        openAccountModal: vi.fn(),
        openChainModal: vi.fn(),
        openConnectModal: vi.fn(),
      }),
  },
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ isConnected: false, address: undefined }),
  useChainId: () => 1,
  useWalletClient: () => ({ data: null }),
}));

vi.mock("qrcode", () => ({
  default: {},
}));

import App from "./App";

const CONTRACT_ADDRESS = "0x1bbf25e71ec48b84d773809b4ba55b6f4be946fb";
const RELATED_ADDRESS = "0x60ca4ec4412a3b319f4bd6366bb836395336b397";
const CURRENT_ABI = [
  {
    type: "function",
    name: "currentRead",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "currentWrite",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
];
const IMPLEMENTATION_ABI = [
  {
    type: "function",
    name: "implementationRead",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "implementationWrite",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
];

function jsonResponse(payload) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(payload),
  });
}

describe("App contract ABI loading", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the entered contract ABI even when a related proxy implementation is unverified", async () => {
    const fetchMock = vi.fn((rawUrl) => {
      const url = new URL(rawUrl);
      const action = url.searchParams.get("action");
      const address = url.searchParams.get("address")?.toLowerCase();

      if (action === "getsourcecode" && address === CONTRACT_ADDRESS) {
        return jsonResponse({
          status: "1",
          result: [
            {
              ABI: JSON.stringify(CURRENT_ABI),
              ContractName: "SourceA",
              Proxy: "1",
              Implementation: RELATED_ADDRESS,
            },
          ],
        });
      }

      if (action === "getsourcecode" && address === RELATED_ADDRESS) {
        return jsonResponse({
          status: "1",
          result: [
            {
              ABI: "Contract source code not verified",
              ContractName: "",
              Proxy: "0",
              Implementation: "",
            },
          ],
        });
      }

      if (action === "getabi" && address === RELATED_ADDRESS) {
        return jsonResponse({
          status: "0",
          result: "Contract source code not verified",
        });
      }

      throw new Error(`Unexpected explorer request: ${url.toString()}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByLabelText("RPC 端点列表（一行一个）"),
      "https://ethereum-rpc.publicnode.com"
    );
    await user.type(
      screen.getByLabelText("浏览器 API 地址（用于拉取 ABI，可选）"),
      "https://api.example.test/api"
    );
    await user.type(screen.getByLabelText("合约地址"), CONTRACT_ADDRESS);
    await user.click(screen.getByRole("button", { name: "加载合约" }));

    expect(await screen.findByText("currentRead")).toBeInTheDocument();
    expect(screen.getByText(/当前合约 ABI 已加载/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Write Contract" }));
    expect(await screen.findByText("currentWrite")).toBeInTheDocument();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    expect(
      fetchMock.mock.calls.some(([rawUrl]) => {
        const url = new URL(rawUrl);
        return (
          url.searchParams.get("action") === "getabi" &&
          url.searchParams.get("address")?.toLowerCase() === CONTRACT_ADDRESS
        );
      })
    ).toBe(false);
  });

  it("renders implementation methods when the entered proxy itself is unverified", async () => {
    const fetchMock = vi.fn((rawUrl) => {
      const url = new URL(rawUrl);
      const action = url.searchParams.get("action");
      const address = url.searchParams.get("address")?.toLowerCase();

      if (action === "getsourcecode" && address === CONTRACT_ADDRESS) {
        return jsonResponse({
          status: "1",
          result: [
            {
              ABI: "Contract source code not verified",
              ContractName: "Proxy",
              Proxy: "1",
              Implementation: RELATED_ADDRESS,
            },
          ],
        });
      }

      if (action === "getsourcecode" && address === RELATED_ADDRESS) {
        return jsonResponse({
          status: "1",
          result: [
            {
              ABI: JSON.stringify(IMPLEMENTATION_ABI),
              ContractName: "OpenImplementation",
              Proxy: "0",
              Implementation: "",
            },
          ],
        });
      }

      throw new Error(`Unexpected explorer request: ${url.toString()}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByLabelText("RPC 端点列表（一行一个）"),
      "https://ethereum-rpc.publicnode.com"
    );
    await user.type(
      screen.getByLabelText("浏览器 API 地址（用于拉取 ABI，可选）"),
      "https://api.example.test/api"
    );
    await user.type(screen.getByLabelText("合约地址"), CONTRACT_ADDRESS);
    await user.click(screen.getByRole("button", { name: "加载合约" }));

    expect(await screen.findByText("implementationRead")).toBeInTheDocument();
    expect(screen.getByText(/代理合约自身 ABI 未开源/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Read As Proxy" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Write Contract" }));
    expect(await screen.findByText("implementationWrite")).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.some(([rawUrl]) => {
        const url = new URL(rawUrl);
        return url.searchParams.get("action") === "getabi";
      })
    ).toBe(false);
  });
});

describe("App URL selection", () => {
  const storageKey = "common-evm-dashboard.templates.v1";
  const firstTemplate = {
    id: "template-a",
    name: "模板 A",
    panel: {
      rpcListText: "https://rpc.example.test",
      selectedRpc: "https://rpc.example.test",
      explorerApi: "https://api.example.test/api",
      contractAddress: CONTRACT_ADDRESS,
      abiText: JSON.stringify(CURRENT_ABI),
    },
    methodStates: {},
  };
  const secondTemplate = { ...firstTemplate, id: "template-b", name: "模板 B" };

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    localStorage.clear();
    localStorage.setItem(storageKey, JSON.stringify([firstTemplate, secondTemplate]));
    vi.stubGlobal("fetch", vi.fn((rawUrl) => {
      const url = new URL(rawUrl);
      const address = url.searchParams.get("address")?.toLowerCase();
      if (url.searchParams.get("action") !== "getsourcecode") {
        throw new Error(`Unexpected explorer request: ${url.toString()}`);
      }
      if (address === CONTRACT_ADDRESS) {
        return jsonResponse({
          status: "1",
          result: [{
            ABI: JSON.stringify(CURRENT_ABI),
            ContractName: "Proxy",
            Proxy: "1",
            Implementation: RELATED_ADDRESS,
          }],
        });
      }
      if (address === RELATED_ADDRESS) {
        return jsonResponse({
          status: "1",
          result: [{
            ABI: JSON.stringify(IMPLEMENTATION_ABI),
            ContractName: "Implementation",
            Proxy: "0",
          }],
        });
      }
      throw new Error(`Unexpected explorer request: ${url.toString()}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it.each([
    ["read", "Read 方法", "currentRead"],
    ["write", "Write 方法", "currentWrite"],
    ["readproxy", "Read As Proxy", "implementationRead"],
    ["writeproxy", "Write As Proxy", "implementationWrite"],
  ])("restores the template and %s view after asynchronous proxy loading", async (tab, heading, method) => {
    window.history.replaceState(
      { preserved: true }, "", `/?template=template-a&tab=${tab}&other=keep#section`
    );
    render(<React.StrictMode><App /></React.StrictMode>);

    await screen.findByText("已检测到代理合约");
    expect(await screen.findByText(method)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "模板 A" })).toBeInTheDocument();
    expect(screen.getByLabelText("合约地址")).toHaveValue(CONTRACT_ADDRESS);
    const url = new URL(window.location.href);
    expect(url.searchParams.get("template")).toBe("template-a");
    expect(url.searchParams.get("tab")).toBe(tab);
    expect(url.searchParams.get("other")).toBe("keep");
    expect(url.hash).toBe("#section");
    expect(window.history.state).toEqual({ preserved: true });
  });

  it("updates the URL on template and scope/tab changes and restores them on remount", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "选择模板" }));
    await user.click(screen.getByRole("button", { name: "模板 A" }));
    await screen.findByText("implementationRead");
    expect(new URLSearchParams(window.location.search).get("template")).toBe("template-a");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("readproxy");

    await user.click(screen.getByRole("button", { name: "当前合约" }));
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("read");
    await user.click(screen.getByRole("button", { name: "Write Contract" }));
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("write");
    await user.click(screen.getByRole("button", { name: "代理实现" }));
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("writeproxy");
    await user.click(screen.getByRole("button", { name: "模板 A" }));
    await user.click(screen.getByRole("button", { name: "模板 B" }));
    await screen.findByText("implementationWrite");
    expect(new URLSearchParams(window.location.search).get("template")).toBe("template-b");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("writeproxy");

    firstRender.unmount();
    render(<App />);
    expect(await screen.findByText("implementationWrite")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "模板 B" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Write As Proxy" })).toBeInTheDocument();
  });

  it("clears the template parameter when the selected template is deleted", async () => {
    window.history.replaceState(null, "", "/?template=template-a&tab=write");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("currentWrite");
    await user.click(screen.getByRole("button", { name: "模板 A" }));
    const templateRow = screen.getAllByRole("button", { name: "模板 A" })
      .find((button) => button.className === "template-item-main").closest(".template-item");
    await user.click(within(templateRow).getByTitle("删除模板"));
    expect(new URLSearchParams(window.location.search).has("template")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("write");
    expect(screen.getByRole("button", { name: "选择模板" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(storageKey)).map((template) => template.id)).toEqual(["template-b"]);
  });

  it("reports a missing template instead of loading another one", () => {
    window.history.replaceState(null, "", "/?template=missing&tab=read");
    render(<App />);
    expect(screen.getByText("URL 指定的模板不存在，请先导入模板或重新选择。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择模板" })).toBeInTheDocument();
    expect(screen.getByLabelText("合约地址")).toHaveValue("");
    expect(fetch).not.toHaveBeenCalled();
  });
});
