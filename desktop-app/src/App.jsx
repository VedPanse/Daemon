import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

const CHATS_KEY = "daemon_chat_sessions_v1";
const STREAM_EVENT = "chat_stream_event";
const CONTEXT_LIMIT = 24;

function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clampTitle(text) {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) {
    return "New Chat";
  }
  return clean.length > 42 ? `${clean.slice(0, 42)}...` : clean;
}

function formatSidebarTime(unixMs) {
  const date = new Date(unixMs);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function App() {
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [draft, setDraft] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [chatSearch, setChatSearch] = useState("");
  const scrollRef = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CHATS_KEY);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }

      const hydrated = parsed
        .filter((chat) => chat && Array.isArray(chat.messages))
        .map((chat) => ({
          id: typeof chat.id === "string" ? chat.id : makeId(),
          title: typeof chat.title === "string" ? chat.title : "New Chat",
          createdAt: Number(chat.createdAt) || Date.now(),
          updatedAt: Number(chat.updatedAt) || Date.now(),
          messages: chat.messages
            .filter(
              (message) =>
                message &&
                typeof message.role === "string" &&
                typeof message.content === "string",
            )
            .map((message) => ({
              id: typeof message.id === "string" ? message.id : makeId(),
              role: message.role,
              content: message.content,
              pending: false,
              requestId: null,
            })),
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);

      setChats(hydrated);
    } catch {
      localStorage.removeItem(CHATS_KEY);
    }
  }, []);

  useEffect(() => {
    const serializable = chats.map(({ id, title, createdAt, updatedAt, messages }) => ({
      id,
      title,
      createdAt,
      updatedAt,
      messages: messages.map(({ id: messageId, role, content }) => ({
        id: messageId,
        role,
        content,
      })),
    }));
    localStorage.setItem(CHATS_KEY, JSON.stringify(serializable));
  }, [chats]);

  const activeChat = useMemo(
    () => chats.find((chat) => chat.id === activeChatId) ?? null,
    [activeChatId, chats],
  );
  const activeMessages = activeChat?.messages ?? [];

  const filteredChats = useMemo(() => {
    const query = chatSearch.trim().toLowerCase();
    if (!query) {
      return chats;
    }
    return chats.filter((chat) => chat.title.toLowerCase().includes(query));
  }, [chatSearch, chats]);

  useEffect(() => {
    const target = scrollRef.current;
    if (!target || !activeChatId) {
      return;
    }
    target.scrollTop = target.scrollHeight;
  }, [activeChatId, activeMessages, isStreaming]);

  useEffect(() => {
    let unlisten;
    let active = true;

    listen(STREAM_EVENT, (event) => {
      if (!active) {
        return;
      }

      const payload = event.payload;
      const stream = streamRef.current;
      if (!stream || !payload || payload.requestId !== stream.requestId) {
        return;
      }

      if (payload.kind === "delta" && typeof payload.delta === "string") {
        setChats((prev) =>
          prev.map((chat) => {
            if (chat.id !== stream.chatId) {
              return chat;
            }

            return {
              ...chat,
              updatedAt: Date.now(),
              messages: chat.messages.map((message) =>
                message.requestId === payload.requestId
                  ? { ...message, content: `${message.content}${payload.delta}` }
                  : message,
              ),
            };
          }),
        );
      }

      if (payload.kind === "done") {
        setIsStreaming(false);
        streamRef.current = null;
        setChats((prev) =>
          prev
            .map((chat) => {
              if (chat.id !== stream.chatId) {
                return chat;
              }

              return {
                ...chat,
                updatedAt: Date.now(),
                messages: chat.messages.map((message) =>
                  message.requestId === payload.requestId
                    ? { ...message, pending: false, requestId: null }
                    : message,
                ),
              };
            })
            .sort((a, b) => b.updatedAt - a.updatedAt),
        );
      }
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => {
        setErrorText("Unable to connect to stream events.");
      });

    return () => {
      active = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const startNewChat = () => {
    if (isStreaming) {
      return;
    }
    setActiveChatId(null);
    setErrorText("");
    setDraft("");
  };

  const deleteChat = (chatId) => {
    if (isStreaming) {
      return;
    }
    setChats((prev) => prev.filter((chat) => chat.id !== chatId));
    if (activeChatId === chatId) {
      setActiveChatId(null);
      setErrorText("");
    }
  };

  const sendPrompt = async () => {
    const prompt = draft.trim();
    if (!prompt || isStreaming) {
      return;
    }

    setDraft("");
    setErrorText("");

    const now = Date.now();
    const requestId = makeId();
    const userMessage = {
      id: makeId(),
      role: "user",
      content: prompt,
      pending: false,
      requestId: null,
    };
    const assistantMessage = {
      id: makeId(),
      role: "assistant",
      content: "",
      pending: true,
      requestId,
    };

    let targetChatId = activeChatId;
    if (!targetChatId) {
      targetChatId = makeId();
      const newChat = {
        id: targetChatId,
        title: clampTitle(prompt),
        createdAt: now,
        updatedAt: now,
        messages: [userMessage, assistantMessage],
      };
      setChats((prev) => [newChat, ...prev]);
      setActiveChatId(targetChatId);
    } else {
      setChats((prev) =>
        prev
          .map((chat) => {
            if (chat.id !== targetChatId) {
              return chat;
            }

            const title = chat.messages.length === 0 ? clampTitle(prompt) : chat.title;
            return {
              ...chat,
              title,
              updatedAt: now,
              messages: [...chat.messages, userMessage, assistantMessage],
            };
          })
          .sort((a, b) => b.updatedAt - a.updatedAt),
      );
    }

    const baseMessages =
      activeChat?.id === targetChatId
        ? activeChat.messages
        : chats.find((chat) => chat.id === targetChatId)?.messages ?? [];

    const contextMessages = [...baseMessages, userMessage]
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-CONTEXT_LIMIT)
      .map(({ role, content }) => ({ role, content }));

    setIsStreaming(true);
    streamRef.current = { requestId, chatId: targetChatId };

    try {
      await invoke("stream_chat", {
        request: {
          requestId,
          model: "gpt-4o-mini",
          messages: contextMessages,
        },
      });
    } catch (error) {
      const message = typeof error === "string" ? error : "Request failed.";
      setErrorText(message);
      setIsStreaming(false);
      streamRef.current = null;
      setChats((prev) =>
        prev.map((chat) => {
          if (chat.id !== targetChatId) {
            return chat;
          }
          return {
            ...chat,
            messages: chat.messages.map((entry) =>
              entry.requestId === requestId
                ? {
                    ...entry,
                    pending: false,
                    requestId: null,
                    content: "I hit an error while contacting the model.",
                  }
                : entry,
            ),
          };
        }),
      );
    }
  };

  return (
    <main className="app-shell">
      <div className="bg-overlay" aria-hidden="true" />

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <span className="logo-mark">D</span>
            <span className="logo-text">Daemon</span>
          </div>

          <label className="search-box">
            <span className="search-icon">⌕</span>
            <input
              value={chatSearch}
              onChange={(event) => setChatSearch(event.currentTarget.value)}
              placeholder="Search chats"
            />
          </label>

          <button
            type="button"
            className="new-chat-btn"
            onClick={startNewChat}
            disabled={isStreaming}
          >
            New Chat
          </button>

          <p className="section-label">Recent Chats</p>
          <div className="history-list">
            {filteredChats.map((chat) => (
              <div
                key={chat.id}
                className={`history-row ${activeChatId === chat.id ? "active" : ""}`}
              >
                <button
                  type="button"
                  className={`history-item ${activeChatId === chat.id ? "active" : ""}`}
                  onClick={() => setActiveChatId(chat.id)}
                >
                  <span className="history-title">{chat.title}</span>
                  <span className="history-meta">
                    {chat.messages.length} msgs · {formatSidebarTime(chat.updatedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  className="delete-chat-btn"
                  onClick={() => deleteChat(chat.id)}
                  disabled={isStreaming}
                  aria-label={`Delete ${chat.title}`}
                  title="Delete chat"
                >
                  ×
                </button>
              </div>
            ))}
            {filteredChats.length === 0 ? (
              <p className="history-empty">No chats found.</p>
            ) : null}
          </div>
        </aside>

        <section className="main-panel">
          {!activeChat ? (
            <div className="home-stage">
              <div className="orb" aria-hidden="true" />
              <h1>
                "Hey Daemon, do something"
              </h1>

              <form
                className={`home-composer ${isStreaming ? "busy" : ""}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  sendPrompt();
                }}
              >
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.currentTarget.value)}
                  placeholder="Message Daemon..."
                  autoComplete="off"
                  spellCheck={false}
                  disabled={isStreaming}
                />
                <button
                  type="submit"
                  disabled={isStreaming || !draft.trim()}
                  className="send-btn"
                  aria-label="Send message"
                >
                  →
                </button>
              </form>

              <div className="feature-grid">
                <article>
                  <h3>Capability Interface</h3>
                  <p>Generates a secure, capability-based command interface from firmware.</p>
                </article>
                <article>
                  <h3>Safety by Design</h3>
                  <p>Applies explicit command bounds, rate limits, watchdogs, and emergency stop.</p>
                </article>
                <article>
                  <h3>Cross-Embodiment</h3>
                  <p>Lets one agent operate diverse compliant devices without device-specific code.</p>
                </article>
              </div>
            </div>
          ) : (
            <div className="chat-stage">
              <div className="messages" ref={scrollRef}>
                {activeMessages.map((message) => (
                  <article
                    key={message.id}
                    className={`bubble ${message.role === "user" ? "bubble-user" : "bubble-assistant"}`}
                  >
                    {message.role === "assistant" ? (
                      <Markdown remarkPlugins={[remarkGfm]}>
                        {message.content || (message.pending ? "Thinking..." : "")}
                      </Markdown>
                    ) : (
                      message.content || (message.pending ? "Thinking..." : "")
                    )}
                  </article>
                ))}
              </div>

              <form
                className={`chat-composer ${isStreaming ? "busy" : ""}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  sendPrompt();
                }}
              >
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.currentTarget.value)}
                  placeholder="Message Daemon..."
                  autoComplete="off"
                  spellCheck={false}
                  disabled={isStreaming}
                />
                <button
                  type="submit"
                  disabled={isStreaming || !draft.trim()}
                  aria-label="Send message"
                >
                  →
                </button>
              </form>
            </div>
          )}

          {errorText ? <p className="error-text">{errorText}</p> : null}
        </section>
      </div>
    </main>
  );
}

export default App;
