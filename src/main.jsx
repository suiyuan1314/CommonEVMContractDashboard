import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  metaMaskWallet,
  okxWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { WagmiProvider, createConfig, http } from "wagmi";
import { defineChain } from "viem";
import "@rainbow-me/rainbowkit/styles.css";
import "./styles.css";
import App from "./App.jsx";

const WALLETCONNECT_PROJECT_ID = "dbcb5d45f04c49f7c2fc17db884f11b4";

const wardenChain = defineChain({
  id: 8765,
  name: "Warden",
  network: "warden",
  nativeCurrency: {
    name: "WARD",
    symbol: "WARD",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://api.explorer.wardenprotocol.org/api/eth-rpc"],
    },
    public: {
      http: ["https://api.explorer.wardenprotocol.org/api/eth-rpc"],
    },
  },
  blockExplorers: {
    default: {
      name: "Warden Explorer",
      url: "https://explorer.wardenprotocol.org",
    },
  },
});

const chains = [wardenChain];

const connectors = connectorsForWallets(
  [
    {
      groupName: "钱包",
      wallets: [metaMaskWallet, okxWallet, walletConnectWallet],
    },
  ],
  {
    appName: "Common EVM Contract Dashboard",
    projectId: WALLETCONNECT_PROJECT_ID,
  }
);

const config = createConfig({
  chains,
  connectors,
  transports: {
    [wardenChain.id]: http(wardenChain.rpcUrls.default.http[0]),
  },
});

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider chains={chains}>
          <App />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);
