import React, { useState, useEffect, useRef } from "react";

const STYLES = [
  { id: "flat", label: "Flat" },
  { id: "for-the-badge", label: "For The Badge" },
  { id: "flat-square", label: "Flat Square" },
  { id: "plastic", label: "Plastic" },
];

function buildStaticBadgeUrl(message, style) {
  return (
    `https://img.shields.io/badge/Rankistan-${encodeURIComponent(message)}-1a7f4e` +
    `?labelColor=0f6e56` +
    `&style=${style}` +
    `&logo=github` +
    `&logoColor=white`
  );
}

function buildBadgeUrl(username, style) {
  const endpoint = `https://rankistan.dev/api/badge/${encodeURIComponent(username)}`;
  return (
    `https://img.shields.io/endpoint` +
    `?url=${encodeURIComponent(endpoint)}` +
    `&style=${style}`
  );
}

function getSnippet(style, username, fmt) {
  const img = buildBadgeUrl(username, style);
  const link = "https://rankistan.dev";
  const alt = "Rankistan rank badge";
  if (fmt === "md") return `[![${alt}](${img})](${link})`;
  if (fmt === "html")
    return `<a href="${link}">\n  <img src="${img}" alt="${alt}">\n</a>`;
  if (fmt === "rst")
    return `.. image:: ${img}\n   :target: ${link}\n   :alt: ${alt}`;
  return "";
}

function CopyButton({ text, className = "" }) {
  const [copied, setCopied] = useState(false);
  const handle = () => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <button
      type="button"
      onClick={handle}
      className={`font-mono text-[10px] uppercase tracking-widest border border-outline-variant px-3 py-1 transition-colors hover:border-primary hover:text-primary ${copied ? "text-tertiary border-tertiary" : "text-outline"} ${className}`}
    >
      {copied ? (
        <span className="flex items-center gap-1.5">
          <span className="material-symbols-outlined text-xs">check</span>
          Copied
        </span>
      ) : (
        <span className="flex items-center gap-1.5">
          <span className="material-symbols-outlined text-xs">
            content_copy
          </span>
          Copy
        </span>
      )}
    </button>
  );
}

function CodeBlock({ code, language = "" }) {
  return (
    <div className="relative group bg-surface-container-lowest border border-outline-variant overflow-x-auto">
      <div className="flex items-center justify-between px-4 py-2 border-b border-outline-variant bg-surface-container-low">
        <span className="font-mono text-[10px] text-outline uppercase tracking-widest">
          {language}
        </span>
        <CopyButton text={code} />
      </div>
      <pre className="p-4 font-mono text-xs text-on-surface-variant leading-relaxed whitespace-pre-wrap break-all">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export default function BadgeGenerator() {
  const [username, setUsername] = useState("");
  const [style, setStyle] = useState("flat");
  const [fmt, setFmt] = useState("md");
  const [rank, setRank] = useState(null);
  const [lookupState, setLookupState] = useState("idle"); // idle | loading | found | notfound | error
  const [badgeLoaded, setBadgeLoaded] = useState(false);
  const [badgeError, setBadgeError] = useState(false);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);
  const leaderboardRef = useRef(null);

  const displayUser = username.trim();

  // Fetch data.json and find the user's rank whenever username changes.
  useEffect(() => {
    if (!displayUser) {
      setRank(null);
      setLookupState("idle");
      return;
    }

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLookupState("loading");
      setRank(null);
      try {
        if (!leaderboardRef.current) {
          const res = await fetch("./data.json");
          leaderboardRef.current = await res.json();
        }

        const data = leaderboardRef.current;
        const dev = (data.leaderboard || []).find(
          (d) => d.username?.toLowerCase() === displayUser.toLowerCase(),
        );
        if (dev) {
          setRank(dev.rank);
          setLookupState("found");
        } else {
          setLookupState("notfound");
        }
      } catch {
        setLookupState("error");
      }
    }, 500);

    return () => clearTimeout(debounceRef.current);
  }, [displayUser]);

  useEffect(() => {
    setBadgeLoaded(false);
    setBadgeError(false);
  }, [rank, style]);

  const badgeUrl = displayUser
    ? buildBadgeUrl(displayUser, style)
    : buildStaticBadgeUrl("not ranked", style);
  const snippet = getSnippet(style, displayUser, fmt);

  return (
    <main className="min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 grid-lines pointer-events-none" />

      <div className="max-w-6xl mx-auto px-6 py-12 relative z-10">
        {/* ── Page Header ── */}
        <div className="mb-12 border-l-4 border-primary pl-6">
          <h1 className="font-headline text-5xl font-extrabold tracking-tighter uppercase text-on-surface mb-2">
            Badge <span className="text-primary">Generator</span>
          </h1>
          <p className="font-mono text-sm text-outline max-w-xl uppercase tracking-widest">
            Display your live Rankistan rank directly in your GitHub README.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-0 border border-outline-variant">
          {/* ── Left Panel: controls ── */}
          <div className="lg:col-span-5 p-8 bg-surface-container-lowest border-b lg:border-b-0 lg:border-r border-outline-variant flex flex-col gap-8">
            {/* Username input */}
            <div>
              <label className="font-mono text-xs text-tertiary uppercase tracking-tighter mb-4 block">
                GitHub Username
              </label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <span className="font-mono text-primary">@</span>
                </div>
                <input
                  ref={inputRef}
                  className="w-full bg-surface-container-low border-b-2 border-outline-variant focus:border-tertiary text-on-surface font-mono py-4 pl-10 pr-4 outline-none transition-all duration-75 placeholder:text-outline/30 uppercase tracking-widest"
                  placeholder="GITHUB_USERNAME"
                  type="text"
                  value={username}
                  onChange={(e) =>
                    setUsername(e.target.value.replace(/\s/g, ""))
                  }
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="mt-2 font-mono text-[10px] uppercase tracking-widest h-4">
                {lookupState === "loading" && (
                  <span className="text-outline animate-pulse">
                    Looking up rank...
                  </span>
                )}
                {lookupState === "found" && (
                  <span className="text-tertiary">✓ Rank #{rank} found</span>
                )}
                {lookupState === "notfound" && (
                  <span className="text-error">Not found in leaderboard</span>
                )}
                {lookupState === "error" && (
                  <span className="text-error">Failed to fetch data</span>
                )}
              </div>
            </div>

            {/* Style selector */}
            <div>
              <label className="font-mono text-xs text-tertiary uppercase tracking-tighter mb-4 block">
                Badge Style
              </label>
              <div className="grid grid-cols-2 gap-2">
                {STYLES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setStyle(s.id)}
                    className={`py-3 px-4 font-mono text-[10px] uppercase tracking-widest border transition-colors text-left ${
                      style === s.id
                        ? "border-primary text-primary bg-primary/10"
                        : "border-outline-variant text-outline hover:border-outline hover:text-on-surface-variant"
                    }`}
                  >
                    {style === s.id && (
                      <span className="material-symbols-outlined text-xs mr-1 align-middle">
                        radio_button_checked
                      </span>
                    )}
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Format selector */}
            <div>
              <label className="font-mono text-xs text-tertiary uppercase tracking-tighter mb-4 block">
                Snippet Format
              </label>
              <div className="flex gap-2">
                {["md", "html", "rst"].map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFmt(f)}
                    className={`flex-1 py-2 font-mono text-[10px] uppercase tracking-widest border transition-colors ${
                      fmt === f
                        ? "border-secondary text-secondary bg-secondary/10"
                        : "border-outline-variant text-outline hover:border-outline hover:text-on-surface-variant"
                    }`}
                  >
                    {f === "md" ? "Markdown" : f === "html" ? "HTML" : "reST"}
                  </button>
                ))}
              </div>
            </div>

            {/* Info box */}
            <div className="border border-outline-variant/50 bg-surface p-4 space-y-2">
              <div className="flex items-center gap-2 mb-3">
                <span className="w-1.5 h-1.5 bg-tertiary animate-pulse" />
                <span className="font-mono text-[10px] text-tertiary uppercase tracking-widest">
                  How It Works
                </span>
              </div>
              {[
                ["1", "Enter your GitHub username"],
                ["2", "Your rank is looked up from the leaderboard data"],
                ["3", "A dynamic Shields endpoint URL is generated"],
                ["4", "Copy the snippet and paste it into your README"],
              ].map(([n, text]) => (
                <div key={n} className="flex items-start gap-3">
                  <span className="font-mono text-[10px] text-on-primary bg-primary px-1.5 py-0.5 shrink-0">
                    {n}
                  </span>
                  <span className="font-body text-xs text-outline leading-relaxed">
                    {text}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* ── Right Panel: preview + snippet ── */}
          <div className="lg:col-span-7 p-8 bg-surface flex flex-col gap-8">
            {/* Badge preview */}
            <div>
              <h3 className="font-mono text-[10px] text-outline uppercase tracking-widest mb-4">
                Live Preview
              </h3>
              <div className="border border-outline-variant bg-surface-container-lowest p-6 flex items-center justify-center min-h-[80px] relative">
                {lookupState === "loading" ? (
                  <span className="font-mono text-[10px] text-outline uppercase tracking-widest animate-pulse">
                    Looking up rank...
                  </span>
                ) : lookupState === "notfound" ? (
                  <span className="font-mono text-xs text-error">
                    User not found in leaderboard
                  </span>
                ) : lookupState === "error" ? (
                  <span className="font-mono text-xs text-error">
                    Failed to load data.json
                  </span>
                ) : (
                  <>
                    {!badgeError ? (
                      <img
                        key={badgeUrl}
                        src={badgeUrl}
                        alt="Rankistan rank badge preview"
                        className={`transition-opacity duration-300 ${badgeLoaded ? "opacity-100" : "opacity-0"}`}
                        onLoad={() => setBadgeLoaded(true)}
                        onError={() => setBadgeError(true)}
                        style={{
                          height: style === "for-the-badge" ? "28px" : "20px",
                        }}
                      />
                    ) : (
                      <span className="font-mono text-xs text-outline">
                        Badge preview unavailable
                      </span>
                    )}
                    {!badgeLoaded && !badgeError && (
                      <span className="font-mono text-[10px] text-outline uppercase tracking-widest animate-pulse absolute">
                        Loading...
                      </span>
                    )}
                  </>
                )}
              </div>

              {/* GitHub README mock */}
              <div className="mt-3 border border-outline-variant bg-[#0d1117] p-4">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-3 h-3 rounded-full bg-[#ff5f56]" />
                  <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
                  <div className="w-3 h-3 rounded-full bg-[#27c840]" />
                  <span className="font-mono text-[10px] text-[#484f58] ml-2">
                    README.md — github.com/{displayUser || "yourusername"}
                  </span>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 bg-[#21262d] border border-[#30363d] flex items-center justify-center shrink-0">
                    <span className="font-mono text-[10px] text-[#8b949e]">
                      {(displayUser || "YO").slice(0, 2).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <p className="font-mono text-sm text-[#e6edf3] mb-2">
                      {displayUser || "yourusername"}
                    </p>
                    <img
                      src={badgeUrl}
                      alt="rank badge"
                      style={{
                        height: style === "for-the-badge" ? "28px" : "20px",
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Snippet — only show when rank is found */}
            <div>
              <h3 className="font-mono text-[10px] text-outline uppercase tracking-widest mb-4">
                Copy Snippet
              </h3>
              {lookupState === "found" ? (
                <CodeBlock
                  code={snippet}
                  language={fmt === "md" ? "markdown" : fmt}
                />
              ) : (
                <div className="border border-outline-variant bg-surface-container-lowest p-4 font-mono text-[10px] text-outline uppercase tracking-widest">
                  Enter your username above to generate your snippet
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
