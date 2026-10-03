import { useMemo, useState } from "react";

interface JsonViewProps {
  value: unknown;
  name?: string;
  depth?: number;
  defaultOpen?: boolean;
}

/** Recursive, collapsible JSON viewer. */
export function JsonView({
  value,
  name,
  depth = 0,
  defaultOpen = true,
}: JsonViewProps) {
  if (value === null || typeof value !== "object") {
    return (
      <div className="json-row">
        {name !== undefined && <span className="json-key">{name}</span>}
        <JsonPrimitive value={value} />
      </div>
    );
  }

  return (
    <JsonBranch
      value={value}
      name={name}
      depth={depth}
      defaultOpen={defaultOpen}
    />
  );
}

function JsonBranch({
  value,
  name,
  depth,
  defaultOpen,
}: {
  value: object;
  name?: string;
  depth: number;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen && depth < 2);
  const entries = useMemo(() => Object.entries(value), [value]);
  const isArray = Array.isArray(value);
  const bracket = isArray ? ["[", "]"] : ["{", "}"];

  return (
    <div className="json-branch">
      <button
        type="button"
        className="json-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="json-caret">{open ? "▾" : "▸"}</span>
        {name !== undefined && <span className="json-key">{name}</span>}
        <span className="json-bracket">{bracket[0]}</span>
        {!open && (
          <span className="json-summary">
            {" "}
            {isArray ? `${entries.length} items` : `${entries.length} keys`}{" "}
            {bracket[1]}
          </span>
        )}
      </button>
      {open && (
        <div className="json-children">
          {entries.map(([key, child]) => (
            <JsonView
              key={key}
              value={child}
              name={isArray ? `[${key}]` : key}
              depth={depth + 1}
              defaultOpen={defaultOpen}
            />
          ))}
          <div className="json-close">{bracket[1]}</div>
        </div>
      )}
    </div>
  );
}

function JsonPrimitive({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <span className="json-string">&quot;{value}&quot;</span>;
  }
  if (typeof value === "number") {
    return <span className="json-number">{value}</span>;
  }
  if (typeof value === "boolean") {
    return <span className="json-boolean">{String(value)}</span>;
  }
  if (value === null) {
    return <span className="json-null">null</span>;
  }
  if (value === undefined) {
    return <span className="json-null">undefined</span>;
  }
  return <span>{String(value)}</span>;
}
