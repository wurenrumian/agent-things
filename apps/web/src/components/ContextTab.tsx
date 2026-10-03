import { contentToText, formatChars, formatNumber } from "../format";
import type { ReactNode } from "react";
import type { ChatMessage, ContextEvent } from "../types";

interface ContextTabProps {
  event: ContextEvent | undefined;
}

export function ContextTab({ event }: ContextTabProps) {
  if (!event) {
    return (
      <p className="empty-note">
        No compiled context yet. Send a message to see what the model receives.
      </p>
    );
  }

  const { breakdown, tools, messages } = event;
  const maxChars = breakdown.sections.reduce(
    (max, section) => Math.max(max, section.chars),
    1,
  );

  return (
    <div className="tab-body">
      <div className="stat-grid">
        <Stat label="Est. tokens" value={formatNumber(breakdown.estimatedTokens)} />
        <Stat label="System chars" value={formatChars(breakdown.systemChars)} />
        <Stat label="Messages" value={formatNumber(breakdown.messageCount)} />
        <Stat label="Tools" value={formatNumber(breakdown.toolCount)} />
      </div>

      <Section title="System prompt sections">
        {breakdown.sections.length === 0 ? (
          <p className="empty-note">No labelled sections.</p>
        ) : (
          <ul className="section-list">
            {breakdown.sections.map((section) => (
              <li key={section.name} className="section-item">
                <div className="section-head">
                  <span className="section-name">{section.name}</span>
                  <span className="section-chars">{formatChars(section.chars)}</span>
                </div>
                <div className="bar">
                  <div
                    className="bar-fill"
                    style={{ width: `${(section.chars / maxChars) * 100}%` }}
                  />
                </div>
                {section.preview && (
                  <pre className="section-preview">{section.preview}</pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {tools.length > 0 && (
        <Section title={`Tools exposed (${tools.length})`}>
          <div className="chip-row">
            {tools.map((tool) => (
              <span className="chip" key={tool}>
                {tool}
              </span>
            ))}
          </div>
        </Section>
      )}

      <Section title={`Messages sent (${messages.length})`}>
        <ol className="sent-list">
          {messages.map((message, index) => (
            <SentMessage key={index} message={message} index={index} />
          ))}
        </ol>
      </Section>
    </div>
  );
}

function SentMessage({ message, index }: { message: ChatMessage; index: number }) {
  const text =
    message.role === "tool"
      ? message.content
      : message.role === "assistant"
        ? (message.content ?? "")
        : contentToText(message.content);
  return (
    <li className={`sent-item sent-${message.role}`}>
      <div className="sent-head">
        <span className={`role role-${message.role}`}>{message.role}</span>
        <span className="sent-index">#{index}</span>
        <span className="sent-len">{formatChars(text.length)} chars</span>
      </div>
      <pre className="sent-body">{text}</pre>
      {message.role === "assistant" && message.tool_calls?.length ? (
        <div className="chip-row">
          {message.tool_calls.map((call) => (
            <span className="chip chip-tool" key={call.id}>
              call {call.function.name}
            </span>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="panel-section">
      <h3 className="panel-title">{title}</h3>
      {children}
    </section>
  );
}
