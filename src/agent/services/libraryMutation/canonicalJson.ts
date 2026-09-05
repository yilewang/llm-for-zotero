function encodeCanonicalJson(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return encodeCanonicalJson(toJSON.call(value));
    }
  }
  if (Array.isArray(value)) {
    return `[${Array.from(
      { length: value.length },
      (_, index) => encodeCanonicalJson(value[index]) ?? "null",
    ).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .flatMap((key) => {
        const encoded = encodeCanonicalJson(record[key]);
        return encoded === undefined
          ? []
          : [`${JSON.stringify(key)}:${encoded}`];
      });
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Canonical JSON comparison used at durable journal boundaries. */
export function canonicalJson(value: unknown): string {
  return encodeCanonicalJson(value) ?? "undefined";
}

export function canonicalJsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
