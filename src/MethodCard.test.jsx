import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@rainbow-me/rainbowkit", () => ({
  ConnectButton: () => null,
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ isConnected: false, address: undefined }),
  useChainId: () => 1,
  useWalletClient: () => ({ data: null }),
}));

vi.mock("qrcode", () => ({
  default: {},
}));

import { MethodCard } from "./App";

function renderMethodCard(fn, savedCallState = undefined) {
  render(
    <MethodCard
      fn={fn}
      kind="write"
      explorerBase=""
      onRead={vi.fn()}
      onWrite={vi.fn()}
      onPersist={vi.fn()}
      methodStorageKey="write:test"
      savedCallState={savedCallState}
    />
  );

  return userEvent.setup();
}

describe("MethodCard timestamp shortcut", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1712641234123);
  });

  afterEach(() => {
    Date.now.mockRestore();
  });

  it("shows the shortcut for matching top-level params and fills the field on click", async () => {
    const user = renderMethodCard({
      type: "function",
      name: "setNonce",
      stateMutability: "nonpayable",
      inputs: [{ name: "nonce", type: "uint256" }],
      outputs: [],
    });

    await user.click(screen.getByText("setNonce"));

    const input = screen.getByRole("textbox", { name: "nonce (uint256)" });
    const button = screen.getByRole("button", { name: "填入当前秒级时间戳" });

    expect(button).toBeInTheDocument();

    await user.click(button);

    expect(input).toHaveValue("1712641234");
  });

  it("does not show the shortcut for unrelated params", async () => {
    const user = renderMethodCard({
      type: "function",
      name: "setSalt",
      stateMutability: "nonpayable",
      inputs: [{ name: "salt", type: "bytes32" }],
      outputs: [],
    });

    await user.click(screen.getByText("setSalt"));

    expect(
      screen.queryByRole("button", { name: "填入当前秒级时间戳" })
    ).not.toBeInTheDocument();
  });

  it("fills matching tuple-array child fields through the same shortcut path", async () => {
    const user = renderMethodCard(
      {
        type: "function",
        name: "setItems",
        stateMutability: "nonpayable",
        inputs: [
          {
            name: "items",
            type: "tuple[]",
            components: [{ name: "sequence", type: "uint64" }],
          },
        ],
        outputs: [],
      },
      {
        tupleArrays: {
          "0": [{ values: { "0": "" }, exponents: {} }],
        },
      }
    );

    await user.click(screen.getByText("setItems"));

    const input = screen.getByRole("textbox", { name: "sequence (uint64)" });
    const button = screen.getByRole("button", { name: "填入当前秒级时间戳" });

    expect(button).toBeInTheDocument();

    await user.click(button);

    expect(input).toHaveValue("1712641234");
  });
});
