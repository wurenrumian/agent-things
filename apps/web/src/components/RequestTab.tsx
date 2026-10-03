import { JsonView } from "./JsonView";
import type { RequestEvent } from "../types";

interface RequestTabProps {
  event: RequestEvent | undefined;
}

export function RequestTab({ event }: RequestTabProps) {
  if (!event) {
    return (
      <p className="empty-note">
        No request sent yet. The literal JSON body will appear here.
      </p>
    );
  }

  const { body, model } = event;
  const toolCount = body.tools?.length ?? 0;

  return (
    <div className="tab-body">
      <div className="request-meta">
        <span className="chip chip-model">{model}</span>
        <span className="meta-note">
          {body.messages.length} messages · {toolCount} tools ·{" "}
          {body.stream ? "streaming" : "non-streaming"}
        </span>
      </div>
      <details className="json-root" open>
        <summary className="json-root-summary">raw request body</summary>
        <div className="json-tree">
          <JsonView value={body} />
        </div>
      </details>
    </div>
  );
}
