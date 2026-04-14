import { describe, expect, it } from "vitest";

import { filterTemplatesByName, sortTemplatesByName } from "./templateUtils";

describe("sortTemplatesByName", () => {
  it("sorts templates by name in ascending alphabetical order", () => {
    const templates = [
      { id: "3", name: "zeta" },
      { id: "1", name: "Alpha" },
      { id: "2", name: "beta" },
    ];

    expect(sortTemplatesByName(templates).map((template) => template.name)).toEqual([
      "Alpha",
      "beta",
      "zeta",
    ]);
  });

  it("keeps a deterministic order when names only differ by case", () => {
    const templates = [
      { id: "b", name: "alpha" },
      { id: "a", name: "Alpha" },
    ];

    expect(sortTemplatesByName(templates).map((template) => template.id)).toEqual(["a", "b"]);
  });
});

describe("filterTemplatesByName", () => {
  it("filters template names with a case-insensitive contains match", () => {
    const templates = [
      { id: "1", name: "Alpha Token" },
      { id: "2", name: "beta config" },
      { id: "3", name: "Gamma" },
    ];

    expect(filterTemplatesByName(templates, "TA")).toEqual([
      { id: "2", name: "beta config" },
    ]);
  });

  it("returns all templates when the query is empty", () => {
    const templates = [{ id: "1", name: "Alpha" }];

    expect(filterTemplatesByName(templates, "   ")).toEqual(templates);
  });
});
