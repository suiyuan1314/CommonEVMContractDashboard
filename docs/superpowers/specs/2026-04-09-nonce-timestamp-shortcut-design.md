# Nonce Timestamp Shortcut Design

Date: 2026-04-09
Status: Proposed and validated with user

## Summary

Add a small clock action beside contract method parameter inputs whose field names match a configurable keyword list. Clicking the action fills the field with the current Unix timestamp in seconds as a decimal string.

This is intended for replay-protection style parameters such as `nonce`, `seq`, and `sequence`, and should work for top-level inputs, tuple children, and tuple-array row children without changing the existing method draft persistence flow.

## Goals

- Show a clock shortcut for parameter names that contain configured keywords.
- Keep the keyword list configurable in code through a constant so new keywords can be added later with a small edit.
- Fill the clicked field with the current Unix timestamp in seconds.
- Apply the same behavior to standard inputs, tuple fields, and tuple-array row fields.
- Preserve existing method state persistence, template save/load behavior, and call/write execution flow.

## Non-Goals

- No runtime UI for editing the keyword list.
- No automatic detection based on ABI type.
- No milliseconds timestamp mode.
- No confirmation dialog before overwriting an existing value.
- No generalized preset system for other field autofill actions.

## Recommended Approach

Use a small, explicit helper-based implementation in `src/App.jsx`:

1. Define a constant keyword list near the other top-level constants.
2. Add a helper that checks whether a parameter name contains any configured keyword using case-insensitive substring matching.
3. Add a helper that returns the current Unix timestamp in seconds as a string.
4. Reuse the existing scoped value update path so the shortcut works for both regular inputs and tuple-backed row inputs.
5. Add minimal styling in `src/styles.css` for an inline action button beside the input.

This keeps the feature local, makes later keyword additions trivial, and avoids changing the existing data model.

## User-Facing Behavior

### Matching Rules

- Match against the parameter's ABI name.
- Matching is case-insensitive.
- A field is eligible when its name contains any configured keyword as a substring.
- Initial keyword list: `nonce`, `seq`, `sequence`.
- If a field has no ABI name, do not show the shortcut.

Examples that should match:

- `nonce`
- `srcNonce`
- `messageSequence`
- `order_seq`

Examples that should not match:

- unnamed arguments such as generated `arg0`
- fields whose names do not contain any configured keyword

### Fill Behavior

- Clicking the clock button replaces the field value with the current Unix timestamp in seconds.
- The inserted value is a base-10 string such as `1775702400`.
- Existing values are overwritten immediately.
- No extra validation or conversion is performed at click time.

### Scope Coverage

- Top-level method inputs
- Expanded tuple child inputs
- Tuple-array row child inputs

The feature is available in both read and write method cards because both use the same parameter entry UI.

## Technical Design

### Constants and Helpers

Add the following local configuration and helpers in `src/App.jsx`:

- `AUTO_TIMESTAMP_PARAM_KEYWORDS`: array of lowercase keyword fragments
- `matchesAutoTimestampParamName(name)`: returns `true` when the trimmed parameter name contains any configured keyword, case-insensitively
- `getCurrentUnixTimestampSeconds()`: returns `Math.floor(Date.now() / 1000).toString()`

The keyword list should remain code-only configuration. Future additions should only require editing the array.

### Render Integration

Within `MethodCard.renderNode`:

- Determine whether the current leaf node should show the shortcut using the original ABI name, not the fallback display label.
- Keep the existing input rendering logic for scaled and non-scaled fields.
- Wrap the input and shortcut action in a shared row container so the button sits beside the field consistently.
- For scaled numeric fields, keep the exponent selector behavior unchanged.

The clock button should:

- use `type="button"` so it never submits anything
- call the existing scoped value setter with `getCurrentUnixTimestampSeconds()`
- include an accessible label such as `填入当前秒级时间戳`
- render as a compact icon-first control

### State and Persistence

No new state container is needed.

The shortcut must write through the existing handlers:

- top-level fields use `handleValueChange`
- tuple-array row fields use `handleTupleArrayValueChange`

Because the feature only changes input values through existing state setters, the following behavior remains unchanged:

- method draft persistence via `onPersist`
- template save/load
- QR import/export payload structure
- argument parsing during read/write calls

## Error Handling and Edge Cases

- Unnamed parameters do not get the shortcut because matching relies on ABI names.
- The shortcut still appears even if the ABI type is not numeric, per validated requirement.
- If a user clicks the shortcut on a non-numeric field and later submits an incompatible call, existing parse/contract error handling remains responsible for surfacing the error.
- Timestamp generation is client-side and depends on the user's local system clock.

## Styling

Add a compact inline action style in `src/styles.css`:

- a row wrapper that keeps the input and clock button aligned
- a small icon button sized to match the existing dense control style
- spacing that still works inside nested tuple layouts

The visual change should stay consistent with the current panel theme and avoid disturbing existing mobile layout behavior.

## Testing Strategy

The repository currently does not include an automated test setup, so implementation planning should include the minimum viable test harness needed to follow TDD.

Required coverage:

- helper test: keyword matching is case-insensitive and substring-based
- helper test: timestamp helper returns a seconds string
- component test: matching field shows the shortcut
- component test: clicking the shortcut fills the current field value
- component test: tuple or tuple-array nested field also uses the same shortcut behavior
- regression check: non-matching field does not show the shortcut

## Acceptance Criteria

- Parameters whose ABI names contain `nonce`, `seq`, or `sequence` show a clock shortcut button.
- Clicking the button fills that exact field with the current Unix timestamp in seconds.
- The behavior works for top-level, tuple, and tuple-array child fields.
- The keyword list is editable in code through a single constant.
- Existing save/load and contract call behavior continue to work without data format changes.
