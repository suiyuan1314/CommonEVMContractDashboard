import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
