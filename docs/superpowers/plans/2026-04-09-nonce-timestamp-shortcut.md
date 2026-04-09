# Nonce Timestamp Shortcut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a clock shortcut to method parameter inputs whose ABI names contain configured replay-protection keywords so a click fills the field with the current Unix timestamp in seconds.

**Architecture:** Keep the feature local to the existing parameter-entry flow by adding a small helper module for keyword matching and timestamp generation, then reuse `MethodCard`'s existing scoped value setters for top-level and nested tuple fields. Add Vitest plus Testing Library first so the behavior is introduced with TDD and verified through both helper tests and `MethodCard` interaction tests.

**Tech Stack:** React 18, Vite 8, Vitest, Testing Library, jsdom

---

## File Structure

**Create:**
- `src/methodParamUtils.js` - code-only configuration and helper functions for timestamp shortcut matching and value generation
- `src/methodParamUtils.test.js` - unit tests for keyword matching and timestamp output
- `src/MethodCard.test.jsx` - component tests covering shortcut visibility and click-to-fill behavior
- `src/test/setup.js` - shared Testing Library setup for Vitest
- `docs/superpowers/plans/2026-04-09-nonce-timestamp-shortcut.md` - this implementation plan

**Modify:**
- `package.json` - add test scripts and test dev dependencies
- `package-lock.json` - lockfile updates from installing test dependencies
- `vite.config.js` - add Vitest configuration with `jsdom` and setup file
- `src/App.jsx` - import helper module, export `MethodCard`, and render the clock shortcut in leaf parameter inputs
- `src/styles.css` - add inline layout and button styles for the new shortcut control

### Task 1: Add the test harness

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vite.config.js`
- Create: `src/test/setup.js`

- [ ] **Step 1: Add test dependencies and scripts**

Run:

```bash
npm install -D vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom
```

Then update `package.json` to:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.1",
    "@vitejs/plugin-react": "^6.0.1",
    "jsdom": "^26.1.0",
    "vite": "^8.0.1",
    "vitest": "^3.2.4"
  }
}
```

- [ ] **Step 2: Configure Vitest for jsdom**

Update `vite.config.js` to:

```js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "docs",
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.js",
  },
});
```

- [ ] **Step 3: Add the shared test setup file**

Create `src/test/setup.js` with:

```js
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: Run the empty harness once**

Run:

```bash
npm test -- --passWithNoTests
```

Expected: Vitest starts successfully and exits cleanly with a message indicating that no test files were found yet.

- [ ] **Step 5: Commit the harness**

Run:

```bash
git add package.json package-lock.json vite.config.js src/test/setup.js
git commit -m "test: add vitest harness"
```

### Task 2: Add helper tests and implement the timestamp helper module

**Files:**
- Create: `src/methodParamUtils.js`
- Create: `src/methodParamUtils.test.js`

- [ ] **Step 1: Write the failing helper tests**

Create `src/methodParamUtils.test.js` with:

```js
import { describe, expect, it, vi } from "vitest";

import {
  AUTO_TIMESTAMP_PARAM_KEYWORDS,
  getCurrentUnixTimestampSeconds,
  matchesAutoTimestampParamName,
} from "./methodParamUtils";

describe("AUTO_TIMESTAMP_PARAM_KEYWORDS", () => {
  it("keeps the default replay-protection keyword list in code", () => {
    expect(AUTO_TIMESTAMP_PARAM_KEYWORDS).toEqual(["nonce", "seq", "sequence"]);
  });
});

describe("matchesAutoTimestampParamName", () => {
  it("matches configured keywords case-insensitively by substring", () => {
    expect(matchesAutoTimestampParamName("nonce")).toBe(true);
    expect(matchesAutoTimestampParamName("srcNonce")).toBe(true);
    expect(matchesAutoTimestampParamName("MESSAGESEQUENCE")).toBe(true);
    expect(matchesAutoTimestampParamName("order_seq")).toBe(true);
  });

  it("returns false for empty or unrelated names", () => {
    expect(matchesAutoTimestampParamName("")).toBe(false);
    expect(matchesAutoTimestampParamName("salt")).toBe(false);
    expect(matchesAutoTimestampParamName(undefined)).toBe(false);
  });
});

describe("getCurrentUnixTimestampSeconds", () => {
  it("returns the current unix timestamp in seconds as a string", () => {
    vi.spyOn(Date, "now").mockReturnValue(1712641234123);

    expect(getCurrentUnixTimestampSeconds()).toBe("1712641234");

    Date.now.mockRestore();
  });
});
```

- [ ] **Step 2: Run the helper test to verify it fails**

Run:

```bash
npm test -- src/methodParamUtils.test.js
```

Expected: FAIL because `src/methodParamUtils.js` does not exist yet.

- [ ] **Step 3: Write the minimal helper implementation**

Create `src/methodParamUtils.js` with:

```js
export const AUTO_TIMESTAMP_PARAM_KEYWORDS = ["nonce", "seq", "sequence"];

export function matchesAutoTimestampParamName(name) {
  const normalizedName = String(name ?? "")
    .trim()
    .toLowerCase();

  if (!normalizedName) return false;

  return AUTO_TIMESTAMP_PARAM_KEYWORDS.some((keyword) =>
    normalizedName.includes(keyword)
  );
}

export function getCurrentUnixTimestampSeconds() {
  return Math.floor(Date.now() / 1000).toString();
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run:

```bash
npm test -- src/methodParamUtils.test.js
```

Expected: PASS with 3 passing tests.

- [ ] **Step 5: Commit the helper module**

Run:

```bash
git add src/methodParamUtils.js src/methodParamUtils.test.js
git commit -m "feat: add timestamp param helpers"
```

### Task 3: Add failing `MethodCard` interaction tests

**Files:**
- Modify: `src/App.jsx`
- Create: `src/MethodCard.test.jsx`

- [ ] **Step 1: Export `MethodCard` so it can be tested directly**

Update the component declaration in `src/App.jsx` from:

```jsx
function MethodCard({
```

to:

```jsx
export function MethodCard({
```

- [ ] **Step 2: Write the failing component tests**

Create `src/MethodCard.test.jsx` with:

```jsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MethodCard } from "./App";

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

    await user.click(button);

    expect(input).toHaveValue("1712641234");
  });
});
```

- [ ] **Step 3: Run the component test to verify it fails**

Run:

```bash
npm test -- src/MethodCard.test.jsx
```

Expected: FAIL because `MethodCard` does not yet render a shortcut button with the accessible name `填入当前秒级时间戳`.

### Task 4: Implement the shortcut UI in `MethodCard`

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Import the helper module into `src/App.jsx`**

Add this import near the top of `src/App.jsx`:

```jsx
import {
  getCurrentUnixTimestampSeconds,
  matchesAutoTimestampParamName,
} from "./methodParamUtils";
```

- [ ] **Step 2: Wire the leaf-field shortcut behavior**

Update the leaf rendering block inside `renderNode` in `src/App.jsx` to:

```jsx
    const showTimestampShortcut = matchesAutoTimestampParamName(node.name);

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
              🕒
            </button>
          )}
        </div>
      </div>
    );
```

- [ ] **Step 3: Add the shortcut layout and button styles**

Add these rules near the existing parameter input styles in `src/styles.css`:

```css
.param-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.param-input-row > input,
.param-input-row > .input-with-addon {
  flex: 1;
  min-width: 0;
}

.param-shortcut-btn {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  border: 1px solid rgba(240, 179, 79, 0.25);
  background: rgba(240, 179, 79, 0.12);
  color: var(--accent-strong);
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  flex: 0 0 auto;
}

.param-shortcut-btn:hover,
.param-shortcut-btn:focus-visible {
  border-color: rgba(240, 179, 79, 0.6);
  background: rgba(240, 179, 79, 0.2);
}
```

- [ ] **Step 4: Run the component tests to verify they pass**

Run:

```bash
npm test -- src/MethodCard.test.jsx
```

Expected: PASS with 3 passing tests.

- [ ] **Step 5: Commit the UI implementation**

Run:

```bash
git add src/App.jsx src/styles.css
git commit -m "feat: add nonce timestamp shortcut"
```

### Task 5: Run the full verification pass

**Files:**
- Test: `src/methodParamUtils.test.js`
- Test: `src/MethodCard.test.jsx`
- Verify: `src/App.jsx`
- Verify: `src/styles.css`

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS with both test files green and no unexpected warnings.

- [ ] **Step 2: Run a production build**

Run:

```bash
npm run build
```

Expected: PASS and Vite emits the production bundle into `docs/`.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git log --stat --oneline -4
```

Expected: only the planned test harness, helper module, `MethodCard` changes, style changes, and test files appear across the four planned commits.

- [ ] **Step 4: Commit the final verification state if anything changed during verification**

Run:

```bash
git status --short
```

Expected: no output. If verification required any fixups, commit them with:

```bash
git add package.json package-lock.json vite.config.js src/test/setup.js src/methodParamUtils.js src/methodParamUtils.test.js src/App.jsx src/MethodCard.test.jsx src/styles.css
git commit -m "chore: finalize nonce timestamp shortcut"
```
