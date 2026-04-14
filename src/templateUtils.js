function normalizeTemplateName(name) {
  return String(name || "").trim();
}

export function sortTemplatesByName(templates) {
  return [...(templates || [])].sort((left, right) => {
    const leftName = normalizeTemplateName(left?.name);
    const rightName = normalizeTemplateName(right?.name);

    const nameCompare = leftName.localeCompare(rightName, undefined, {
      sensitivity: "base",
    });
    if (nameCompare !== 0) return nameCompare;

    return String(left?.id || "").localeCompare(String(right?.id || ""));
  });
}

export function filterTemplatesByName(templates, query) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return templates || [];

  return (templates || []).filter((template) =>
    normalizeTemplateName(template?.name).toLowerCase().includes(normalizedQuery)
  );
}
