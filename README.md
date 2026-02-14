# Common EVM Contract Dashboard

## 项目简介

Common EVM Contract Dashboard 是一个基于 React 和 Vite 构建的前端项目，旨在为 Warden 链等 EVM 兼容链提供合约交互和钱包连接功能。项目集成了 RainbowKit 和 Wagmi，实现多钱包支持（MetaMask、OKX、WalletConnect），并通过自定义链配置连接 Warden 网络。

## 技术栈
- React
- Vite
- RainbowKit
- Wagmi
- @tanstack/react-query

## 功能特性
- 支持多种钱包连接
- 集成 Warden 链自定义配置
- 合约交互与数据展示

## 快速开始
1. 安装依赖：
   ```bash
   npm install
   ```
2. 启动开发服务器：
   ```bash
   npm run dev
   ```

## 目录结构
- `src/`：主要源代码，包括 App.jsx、main.jsx、styles.css
- `build/`：打包后的静态资源
- `index.html`：入口 HTML 文件
- `app.js`：主应用 JS 文件

## 相关链接
- [Warden Explorer](https://explorer.wardenprotocol.org)

---
如需更多帮助或反馈，请提交 issue。
