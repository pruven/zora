"use client";

import { MarkGithubIcon } from "@primer/octicons-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowDownToLine,
  Search,
  FolderOpen,
  LayoutGrid,
  List,
  Menu,
  HelpCircle,
  RefreshCw,
  AlertCircle,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  Copy,
  FileAudio,
  FileImage,
  FileVideo,
  Flag,
  Globe2,
  HardDrive,
  LoaderCircle,
  LogOut,
  Plus,
  ShieldCheck,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useSidebarResize } from "@/components/sidebar-resizer";
import { authClient } from "@/lib/auth-client";
import { ACCEPT, MAX_FILE_BYTES } from "@/lib/config";

type SharedFile = {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  expiresAt: number;
  url: string;
};
type Capacity = {
  used: number;
  total: number;
  personal: number | null;
  personalTotal: number;
};
function bytes(n: number) {
  return n < 1_000_000
    ? `${(n / 1000).toFixed(n ? 1 : 0)} KB`
    : n < 1_000_000_000
      ? `${(n / 1_000_000).toFixed(1)} MB`
      : `${(n / 1_000_000_000).toFixed(2)} GB`;
}
function FileIcon({ mime }: { mime: string }) {
  const Icon = mime.startsWith("image/")
    ? FileImage
    : mime.startsWith("audio/")
      ? FileAudio
      : FileVideo;
  return <Icon size={21} strokeWidth={1.6} />;
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="dialog-top">
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button"
          onClick={close}
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function Dashboard() {
  const { sidebarStyle, resizeHandle } = useSidebarResize();
  const { data: session, isPending } = authClient.useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [fileType, setFileType] = useState("all");
  const [view, setView] = useState<"list" | "grid">("list");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [filesError, setFilesError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [latestFile, setLatestFile] = useState<SharedFile | null>(null);
  const [files, setFiles] = useState<SharedFile[]>([]);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [busyAuth, setBusyAuth] = useState(false);
  const [authError, setAuthError] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<{
    name: string;
    progress: number;
    processing: boolean;
  } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SharedFile | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const [rules, setRules] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const activeRequest = useRef<XMLHttpRequest | null>(null);
  const userId = session?.user.id;
  const currentUser = useRef(userId);
  const refreshGeneration = useRef(0);
  const storageFull = !!capacity && capacity.used >= capacity.total;
  const uploadDisabled = isPending || !!upload || storageFull;

  useLayoutEffect(() => {
    currentUser.current = userId;
    refreshGeneration.current += 1;
    setFiles([]);
    setFilesError("");
    setLoadingFiles(isPending || !!userId);
    setCapacity(null);
    setStorageError(false);
    setLatestFile(null);
    setDeleting(null);
    return () => {
      refreshGeneration.current += 1;
    };
  }, [userId, isPending]);
  useEffect(() => {
    if (!menuOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.querySelector<HTMLButtonElement>(".mobile-close")?.focus();
    const onResize = () => {
      if (window.innerWidth > 820) setMenuOpen(false);
    };
    window.addEventListener("resize", onResize);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("resize", onResize);
      previousFocus?.focus();
    };
  }, [menuOpen]);

  const refresh = useCallback(async () => {
    if (currentUser.current !== userId) return;
    const generation = ++refreshGeneration.current;
    const isCurrent = () =>
      generation === refreshGeneration.current &&
      currentUser.current === userId;
    await Promise.all([
      (async () => {
        try {
          const response = await fetch("/api/storage", { cache: "no-store" });
          if (!response.ok) throw new Error();
          const data = await response.json();
          if (!isCurrent()) return;
          setCapacity(data);
          setStorageError(false);
        } catch {
          if (isCurrent()) setStorageError(true);
        }
      })(),
      (async () => {
        if (isPending) return;
        try {
          if (userId) {
            const response = await fetch("/api/files", { cache: "no-store" });
            const data = await response.json();
            if (!response.ok)
              throw new Error(data.error || "Could not load files.");
            if (!isCurrent()) return;
            setFiles(data.files);
          } else {
            setFiles([]);
          }
          if (isCurrent()) setFilesError("");
        } catch (cause) {
          if (!isCurrent()) return;
          setFilesError(
            cause instanceof Error ? cause.message : "Could not load files.",
          );
        } finally {
          if (isCurrent()) setLoadingFiles(false);
        }
      })(),
    ]);
  }, [userId, isPending]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => () => activeRequest.current?.abort(), []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 5000);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("auth_error") === "github") {
      setError("GitHub sign-in did not finish. Please try again.");
      url.searchParams.delete("auth_error");
      window.history.replaceState(null, "", url);
    }
  }, []);

  function chooseFile() {
    if (isPending || upload) return;
    if (storageFull) {
      setError("Shared storage is full. Try again after some files expire.");
      return;
    }
    setError("");
    if (!session) {
      setAuthError("");
      setAuthOpen(true);
      return;
    }
    input.current?.click();
  }
  async function sendFile(file: File) {
    if (isPending || upload) return;
    if (storageFull) {
      setError("Shared storage is full. Try again after some files expire.");
      return;
    }
    setError("");
    if (!session) {
      setAuthError("");
      setAuthOpen(true);
      return;
    }
    if (!file.size || file.size > MAX_FILE_BYTES) {
      setError("Choose a non-empty file, 10 MB or smaller.");
      return;
    }
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!extension || !ACCEPT.split(",").includes(`.${extension}`)) {
      setError(
        "This file type is blocked. Choose a supported image, audio, or video file.",
      );
      return;
    }
    setUpload({ name: file.name, progress: 0, processing: false });
    let completionRequested = false;
    try {
      const initialized = await fetch("/api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size }),
        signal: AbortSignal.timeout(30_000),
      });
      const target = await initialized.json();
      if (!initialized.ok)
        throw new Error(target.error || "Could not start the upload.");
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        activeRequest.current = xhr;
        xhr.open(target.upload.method, target.upload.url);
        for (const [name, value] of Object.entries(target.upload.headers))
          xhr.setRequestHeader(name, String(value));
        xhr.timeout = 120_000;
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable)
            setUpload({
              name: file.name,
              progress: Math.round((event.loaded / event.total) * 100),
              processing: event.loaded === event.total,
            });
        };
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(
                new Error("The file could not be uploaded. Please try again."),
              );
        xhr.onerror = () =>
          reject(
            new Error(
              "The upload connection failed. Check your connection and try again.",
            ),
          );
        xhr.ontimeout = () =>
          reject(new Error("The upload timed out. Please try again."));
        xhr.onabort = () => reject(new Error("Upload cancelled."));
        xhr.send(file);
      });
      activeRequest.current = null;
      setUpload({ name: file.name, progress: 100, processing: true });
      completionRequested = true;
      const completed = await fetch(`/api/files/${target.id}/complete`, {
        method: "POST",
        // Bound the client wait beyond the server's 120-second completion budget.
        signal: AbortSignal.timeout(150_000),
      });
      const result = await completed.json();
      if (!completed.ok)
        throw new Error(result.error || "Could not finish the upload.");
      setLatestFile(result.file);
      setQuery("");
      setMessage(`${result.file.name} is ready to share.`);
    } catch (cause) {
      const timeoutMessage = completionRequested
        ? "The request timed out. Refresh your files before trying again; processing may still finish."
        : "Starting the upload timed out. Please try again.";
      setError(
        cause instanceof Error && cause.name === "TimeoutError"
          ? timeoutMessage
          : cause instanceof Error
            ? cause.message
            : "Upload failed.",
      );
      // Do not cancel a completion that may still be running after a network error.
      // Its retained reservation and private staging object are recovered by cleanup.
    } finally {
      setUpload(null);
      activeRequest.current = null;
      void refresh();
    }
  }
  async function copy(file: SharedFile) {
    try {
      await navigator.clipboard.writeText(file.url);
      setCopied(file.id);
      setTimeout(() => setCopied(null), 2500);
    } catch {
      setError(
        "Clipboard access failed. Use the download link to copy its address.",
      );
    }
  }
  const percent = capacity
    ? Math.min(100, Math.max(0, (capacity.used / capacity.total) * 100))
    : 0;
  const visibleFiles = files
    .filter(
      (file) =>
        file.name.toLowerCase().includes(query.toLowerCase()) &&
        (fileType === "all" || file.mime.startsWith(`${fileType}/`)),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "expiring"
          ? a.expiresAt - b.expiresAt
          : b.createdAt - a.createdAt,
    );

  return (
    <div className="site-shell" style={sidebarStyle}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {menuOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside
        className={`sidebar ${menuOpen ? "is-open" : ""}`}
        aria-label="Workspace sidebar"
        id="workspace-sidebar"
        onKeyDown={(event) => {
          if (!menuOpen) return;
          if (event.key === "Escape") setMenuOpen(false);
          if (event.key === "Tab") {
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                "a[href], button:not(:disabled)",
              ),
            ).filter((item) => item.offsetParent !== null);
            const first = items[0];
            const last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            }
            if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="sidebar-brand">
          <a href="/" className="brand" aria-label="Zora home">
            <Sun size={30} strokeWidth={1.7} />
            zora<span> / share</span>
          </a>
          <button
            className="icon-button mobile-close"
            aria-label="Close navigation"
            onClick={() => setMenuOpen(false)}
          >
            <X size={20} />
          </button>
        </div>
        <button
          className="button button-primary sidebar-upload"
          disabled={uploadDisabled}
          onClick={() => {
            setMenuOpen(false);
            chooseFile();
          }}
        >
          <Plus size={18} /> {storageFull ? "Storage is full" : "Upload a file"}{" "}
          <span>↑</span>
        </button>
        <div className="sidebar-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="File navigation">
          {[
            { id: "all", name: "All files", icon: FolderOpen },
            { id: "image", name: "Images", icon: FileImage },
            { id: "audio", name: "Audio", icon: FileAudio },
            { id: "video", name: "Video", icon: FileVideo },
          ].map(({ id, name, icon: Icon }) => (
            <button
              key={id}
              className={`side-link ${fileType === id ? "active" : ""}`}
              aria-pressed={fileType === id}
              onClick={() => {
                setFileType(id);
                setMenuOpen(false);
                document
                  .getElementById("files")
                  ?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              <Icon size={18} />
              {name}
              <span>
                {session
                  ? files.filter(
                      (file) => id === "all" || file.mime.startsWith(`${id}/`),
                    ).length
                  : "—"}
              </span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <section
            className="capacity-panel"
            aria-labelledby="capacity-heading"
          >
            <div className="panel-label">
              <span>
                <Globe2 size={15} />
                Shared space
              </span>
            </div>
            <h2 id="capacity-heading">Community storage</h2>
            <div className="capacity-numbers">
              <strong>{capacity ? bytes(capacity.used) : "—"}</strong>
              <span>/ {capacity ? bytes(capacity.total) : "9.50 GB"}</span>
            </div>
            <div
              className="progress-track capacity-track"
              role="progressbar"
              aria-label="Global storage used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent)}
            >
              <div style={{ width: `${Math.min(percent, 100)}%` }} />
            </div>
            <div className="capacity-legend">
              <span>
                <i />
                {storageError
                  ? "Capacity unavailable"
                  : capacity
                    ? `${Math.max(0, 100 - percent).toFixed(1)}% available`
                    : "Loading capacity…"}
              </span>
              <span>used + reserved</span>
            </div>
            <p>Expired files free up space for everyone.</p>
            {storageError && (
              <button className="text-button" onClick={() => void refresh()}>
                <RefreshCw size={14} /> Retry capacity
              </button>
            )}
          </section>

          <button
            className="sidebar-help"
            onClick={() => {
              setRules(true);
              setMenuOpen(false);
            }}
          >
            <HelpCircle size={17} />
            How Zora works
            <ArrowUpRight size={14} />
          </button>
          <button
            className="sidebar-help"
            onClick={() => {
              setReporting(true);
              setMenuOpen(false);
            }}
          >
            <Flag size={16} />
            Report a file
            <ArrowUpRight size={14} />
          </button>
          <a
            className="sidebar-help"
            href="https://github.com/pruven/zora"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setMenuOpen(false)}
          >
            <MarkGithubIcon size={17} aria-hidden="true" />
            View on GitHub
            <ArrowUpRight size={14} aria-hidden="true" />
          </a>
          <div className="sidebar-foot">
            <span className="status-dot" /> Temporary by design.
          </div>
        </div>
      </aside>
      {resizeHandle}
      <div className="app-body">
        <main className="wrap" id="main-content">
          <section className="intro" aria-labelledby="main-title">
            <div className="intro-actions">
              <button
                className="icon-button menu-toggle"
                aria-label="Open navigation"
                aria-expanded={menuOpen}
                aria-controls="workspace-sidebar"
                onClick={() => setMenuOpen(!menuOpen)}
              >
                <Menu size={20} />
              </button>
              <a href="/" className="brand mobile-brand" aria-label="Zora home">
                <Sun size={18} strokeWidth={1.7} />
                zora
              </a>
              <div className="account">
                {session ? (
                  <>
                    <span className="account-name">{session.user.name}</span>
                    <button
                      className="icon-button"
                      aria-label="Sign out"
                      disabled={!!upload}
                      onClick={async () => {
                        await authClient.signOut();
                        refreshGeneration.current += 1;
                        setFilesError("");
                        setFiles([]);
                        setLatestFile(null);
                      }}
                    >
                      <LogOut size={18} />
                    </button>
                  </>
                ) : (
                  <button
                    className="button button-secondary"
                    disabled={isPending}
                    onClick={() => {
                      setAuthError("");
                      setAuthOpen(true);
                    }}
                  >
                    Sign in <ArrowUpRight size={15} />
                  </button>
                )}
              </div>
            </div>
            <div className="intro-copy">
              <div className="eyebrow">YOUR SHARING SPACE</div>
              <h1 id="main-title">
                A little less keeping.
                <br className="mobile-title-break" />{" "}
                <span>A little more sharing.</span>
              </h1>
              <p>Upload a file, grab a link, and carry on.</p>
            </div>
          </section>
          <div className="workspace">
            <div className="upload-story">
              <span className="hero-label">
                <span className="status-dot" /> MADE FOR THE MOMENT
              </span>
              <h2>
                Send the file.
                <br />
                <span>Keep things moving.</span>
              </h2>
              <p>
                A photo, a clip, a recording. Give it a link and send it on its
                way.
              </p>
              <div className="format-stack" aria-hidden="true">
                <div className="format-tile format-image">
                  <FileImage size={27} strokeWidth={1.4} />
                  <span>JPG</span>
                </div>
                <div className="format-tile format-audio">
                  <FileAudio size={27} strokeWidth={1.4} />
                  <span>MP3</span>
                </div>
                <div className="format-tile format-video">
                  <FileVideo size={27} strokeWidth={1.4} />
                  <span>MP4</span>
                </div>
                <span className="format-note">
                  Small files.
                  <br />
                  Endless possibilities.
                </span>
              </div>
            </div>
            <section
              className={`upload-panel ${dragging ? "dragging" : ""}`}
              aria-labelledby="upload-heading"
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node))
                  setDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (e.dataTransfer.files.length !== 1) {
                  setError("Upload one file at a time.");
                  return;
                }
                void sendFile(e.dataTransfer.files[0]);
              }}
            >
              <div className="panel-label">
                <span>
                  <Upload size={15} />
                  QUICK UPLOAD
                </span>
                <span className="subtle">10 MB / file</span>
              </div>
              <div className="drop-content">
                <div className="upload-glyph">
                  <Upload size={33} strokeWidth={1.35} />
                </div>
                <h2 id="upload-heading">
                  {upload
                    ? upload.processing
                      ? "Checking your file…"
                      : "Sending your file…"
                    : dragging
                      ? "Drop it right here"
                      : "Drop your file here"}
                </h2>
                <p>
                  {upload
                    ? upload.name
                    : "Images, audio, and video up to 10 MB"}
                </p>
                {upload ? (
                  <div className="upload-progress" role="status">
                    <div
                      className="progress-track"
                      role="progressbar"
                      aria-label="File upload"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={upload.progress}
                    >
                      <div style={{ width: `${upload.progress}%` }} />
                    </div>
                    <span>
                      {upload.processing
                        ? "Validating and saving securely"
                        : `${upload.progress}% uploaded`}
                    </span>
                  </div>
                ) : (
                  <button
                    className="button button-primary"
                    disabled={uploadDisabled}
                    onClick={chooseFile}
                  >
                    <Plus size={18} />
                    {storageFull ? "Storage is full" : "Choose a file"}
                    <ChevronRight size={15} />
                  </button>
                )}
                <input
                  ref={input}
                  type="file"
                  tabIndex={-1}
                  accept={ACCEPT}
                  className="visually-hidden"
                  aria-label="Choose a file to upload"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void sendFile(file);
                    e.target.value = "";
                  }}
                />
                {!upload && (
                  <span className="upload-hint">
                    {session
                      ? "or drag and drop it here"
                      : "Sign in with GitHub to upload"}
                  </span>
                )}
              </div>
              <div className="upload-bottom">
                <span>
                  <Clock3 size={15} />
                  Auto-expires in 10 days
                </span>
                <span>
                  <ShieldCheck size={15} />
                  Public link
                </span>
              </div>
            </section>
          </div>
          {latestFile && session && (
            <div className="share-result" role="status">
              <span className="result-check">
                <Check size={20} />
              </span>
              <div>
                <strong>Ready to pass along.</strong>
                <p>{latestFile.name}</p>
              </div>
              <button
                className="button button-primary"
                onClick={() => void copy(latestFile)}
              >
                {copied === latestFile.id ? (
                  <CheckCheck size={16} />
                ) : (
                  <Copy size={16} />
                )}
                {copied === latestFile.id ? "Copied!" : "Copy link"}
              </button>
              <button
                className="icon-button"
                aria-label="Dismiss uploaded file"
                onClick={() => setLatestFile(null)}
              >
                <X size={18} />
              </button>
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={17} />
              </button>
            </div>
          )}
          <section
            id="files"
            className="files-section"
            aria-labelledby="files-heading"
          >
            <div className="section-top">
              <div>
                <h2 id="files-heading">
                  File library{" "}
                  <span className="count">
                    {files.length.toString().padStart(2, "0")}
                  </span>
                </h2>
                <p>
                  {session
                    ? "Everything you’re sharing, all in one place."
                    : "Sign in with GitHub to keep track of what you share."}
                </p>
              </div>
              {session &&
                capacity?.personal !== null &&
                capacity?.personal !== undefined && (
                  <span className="personal-storage">
                    <HardDrive size={14} />
                    {bytes(capacity.personal)} of 100 MB used
                  </span>
                )}
            </div>
            <div className="library-controls">
              <div
                className="filter-tabs"
                role="group"
                aria-label="Filter files"
              >
                {[
                  { id: "all", name: "All files" },
                  { id: "image", name: "Images" },
                  { id: "audio", name: "Audio" },
                  { id: "video", name: "Video" },
                ].map(({ id, name }) => (
                  <button
                    key={id}
                    aria-pressed={fileType === id}
                    className={fileType === id ? "selected" : ""}
                    onClick={() => setFileType(id)}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <div
                className="view-controls"
                role="group"
                aria-label="File layout"
              >
                <button
                  className={`icon-button ${view === "list" ? "selected" : ""}`}
                  aria-label="List view"
                  aria-pressed={view === "list"}
                  onClick={() => setView("list")}
                >
                  <List size={17} />
                </button>
                <button
                  className={`icon-button ${view === "grid" ? "selected" : ""}`}
                  aria-label="Grid view"
                  aria-pressed={view === "grid"}
                  onClick={() => setView("grid")}
                >
                  <LayoutGrid size={16} />
                </button>
              </div>
            </div>
            <div className="file-toolbar">
              <label className="search-field">
                <Search size={17} />
                <input
                  type="search"
                  placeholder="Search your files…"
                  aria-label="Search your files"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <label className="sort-field">
                <span>Sort by</span>
                <select
                  aria-label="Sort files"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="newest">Newest first</option>
                  <option value="expiring">Expiring soon</option>
                  <option value="name">File name</option>
                </select>
              </label>
            </div>
            {filesError && (
              <div className="notice" role="alert">
                <AlertCircle size={18} />
                <span>{filesError}</span>
                <button className="text-button" onClick={() => void refresh()}>
                  <RefreshCw size={14} />
                  Retry
                </button>
              </div>
            )}
            {loadingFiles || isPending ? (
              <div className="loading-files" role="status">
                <LoaderCircle size={20} className="spin" /> Loading your files…
              </div>
            ) : files.length ? (
              <div
                className={`file-table ${view === "grid" ? "file-grid" : ""}`}
              >
                <div className="table-heading">
                  <span>File</span>
                  <span>Expires</span>
                  <span>Share</span>
                </div>
                {visibleFiles.map((file) => (
                  <div className="file-row" key={file.id}>
                    <div className="file-info">
                      <div className="file-icon">
                        <FileIcon mime={file.mime} />
                      </div>
                      <div>
                        <strong title={file.name}>{file.name}</strong>
                        <span>
                          {bytes(file.size)} <b>·</b>{" "}
                          {file.mime.startsWith("image/")
                            ? "Image"
                            : file.mime.startsWith("audio/")
                              ? "Audio"
                              : "Video"}
                        </span>
                      </div>
                    </div>
                    <div className="file-expiry">
                      <Clock3 size={14} />
                      <span title={new Date(file.expiresAt).toLocaleString()}>
                        {Math.max(
                          0,
                          Math.ceil((file.expiresAt - Date.now()) / 86_400_000),
                        )}{" "}
                        days left
                      </span>
                    </div>
                    <div className="file-actions">
                      <button
                        className="button copy-button"
                        onClick={() => void copy(file)}
                      >
                        {copied === file.id ? (
                          <CheckCheck size={15} />
                        ) : (
                          <Copy size={15} />
                        )}
                        {copied === file.id ? "Copied" : "Copy link"}
                      </button>
                      <a
                        className="icon-button"
                        href={file.url}
                        aria-label={`Download ${file.name}`}
                      >
                        <ArrowDownToLine size={17} />
                      </a>
                      <button
                        className="icon-button delete-button"
                        aria-label={`Delete ${file.name}`}
                        onClick={() => setDeleting(file)}
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                  </div>
                ))}
                {!visibleFiles.length && (
                  <div className="no-results">
                    <Search size={24} />
                    <h3>No matching files</h3>
                    <p>Try another name or reset the file filters.</p>
                    <button
                      className="text-button"
                      onClick={() => {
                        setQuery("");
                        setFileType("all");
                      }}
                    >
                      Reset filters <X size={14} />
                    </button>
                  </div>
                )}
              </div>
            ) : !filesError ? (
              <div className="empty-files">
                <div className="empty-icon">
                  <FolderOpen size={29} strokeWidth={1.3} />
                </div>
                <div>
                  <h3>A clear space. A fresh start.</h3>
                  <p>
                    {session
                      ? "Upload your first file. We’ll keep it here for 10 days."
                      : "Sign in with GitHub, upload a file, and send it on its way."}
                  </p>
                </div>
                <button
                  className="text-button"
                  disabled={uploadDisabled}
                  onClick={chooseFile}
                >
                  <Plus size={15} />
                  {session ? "Upload your first file" : "Sign in to upload"}
                  <ArrowUpRight size={17} />
                </button>
              </div>
            ) : null}
          </section>
          <div className="workspace-note">
            <ShieldCheck size={14} />
            <span>Only media files. Automatically expires. Always simple.</span>
            <button onClick={() => setRules(true)}>
              View supported formats <ArrowUpRight size={13} />
            </button>
          </div>
        </main>
        <footer className="wrap footer">
          <span>Small files. Short stays.</span>
          <span>
            Made to be passed along. <Sun size={13} />
          </span>
        </footer>
      </div>
      {message && (
        <div className="toast" role="status">
          <Check size={18} />
          {message}
        </div>
      )}
      {authOpen && (
        <Modal
          title="Sign in with GitHub"
          close={() => {
            if (!busyAuth) setAuthOpen(false);
          }}
        >
          <p className="dialog-description">
            Use your GitHub account to upload and manage your files. Anyone with
            a file link can download without signing in.
          </p>
          {authError && (
            <p role="alert" className="form-error">
              {authError}
            </p>
          )}
          <button
            className="button button-primary form-submit"
            disabled={busyAuth}
            onClick={async () => {
              setAuthError("");
              setBusyAuth(true);
              try {
                const result = await authClient.signIn.social({
                  provider: "github",
                  callbackURL: "/",
                  errorCallbackURL: "/?auth_error=github",
                });
                if (result.error) {
                  setAuthError(
                    result.error.message || "Could not sign in with GitHub.",
                  );
                  setBusyAuth(false);
                }
              } catch {
                setAuthError("Connection failed. Try again.");
                setBusyAuth(false);
              }
            }}
          >
            {busyAuth ? <LoaderCircle className="spin" size={18} /> : null}
            {busyAuth ? "Connecting to GitHub…" : "Continue with GitHub"}
            <ArrowUpRight size={16} />
          </button>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="Delete this file?"
          close={() => {
            if (!busyDelete) setDeleting(null);
          }}
        >
          <p className="dialog-description">
            The link to <strong>{deleting.name}</strong> will stop working
            immediately. This cannot be undone.
          </p>
          <div className="dialog-actions">
            <button
              className="button button-secondary"
              disabled={busyDelete}
              onClick={() => setDeleting(null)}
            >
              Keep file
            </button>
            <button
              className="button button-danger"
              disabled={busyDelete}
              onClick={async () => {
                setBusyDelete(true);
                try {
                  const response = await fetch(`/api/files/${deleting.id}`, {
                    method: "DELETE",
                  });
                  if (!response.ok)
                    throw new Error((await response.json()).error);
                  if (latestFile?.id === deleting.id) setLatestFile(null);
                  setDeleting(null);
                  setMessage("File deleted. Its link is no longer available.");
                  void refresh();
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Could not delete file.",
                  );
                  setDeleting(null);
                } finally {
                  setBusyDelete(false);
                }
              }}
            >
              {busyDelete ? "Deleting…" : "Delete file"}
            </button>
          </div>
        </Modal>
      )}
      {rules && (
        <Modal title="Small files. Clear rules." close={() => setRules(false)}>
          <div className="rules-content">
            <p>
              Upload a file up to <strong>10 MB</strong>. Its public link
              expires exactly <strong>10 days</strong> after upload. Anyone with
              the link can download and keep a copy.
            </p>
            <h3>Supported formats</h3>
            <p>
              JPG, PNG, WebP, MP3, WAV, MP4, WebM, OGG, and FLAC. Images are
              processed to remove metadata and embedded payloads.
            </p>
            <h3>Blocked files</h3>
            <p>
              Scripts, executables, archives, SVG, HTML, PDFs, and office
              documents. We check the filename and actual file contents on the
              server.
            </p>
            <h3>A fair share</h3>
            <p>
              Each account gets 100 MB and 20 upload attempts per day. The
              community pool holds 9.5 GB, with space reserved below the
              provider’s 10 GB limit.
            </p>
            <h3>Share thoughtfully</h3>
            <p>
              Only share files you have permission to distribute. Do not upload
              malware, illegal content, or private information. Links are
              public; this is not a private vault.
            </p>
          </div>
        </Modal>
      )}
      {reporting && (
        <Modal
          title="Report a file"
          close={() => {
            if (!reportBusy) setReporting(false);
          }}
        >
          <p className="dialog-description">
            Paste the Zora file link. We’ll flag it for review.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setReportBusy(true);
              try {
                const link = String(new FormData(e.currentTarget).get("link"));
                const match = new URL(link).pathname.match(
                  /^\/f\/([a-f0-9]{48})\//,
                );
                if (!match) throw new Error("Enter a valid Zora file link.");
                const response = await fetch("/api/reports", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ id: match[1] }),
                });
                if (!response.ok)
                  throw new Error((await response.json()).error);
                setReporting(false);
                setMessage(
                  "File reported. Thank you for helping keep this space useful.",
                );
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not report file.",
                );
                setReporting(false);
              } finally {
                setReportBusy(false);
              }
            }}
          >
            <label>
              File link
              <input
                name="link"
                type="url"
                required
                maxLength={1000}
                placeholder="Paste the full file link"
              />
            </label>
            <button
              className="button button-primary form-submit"
              disabled={reportBusy}
            >
              {reportBusy ? "Reporting…" : "Report file"}
              <Flag size={16} />
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
