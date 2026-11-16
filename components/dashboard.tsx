"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
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
  Link2,
  LoaderCircle,
  LogOut,
  Plus,
  ShieldCheck,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
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
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="dialog-top">
        <h2>{title}</h2>
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
  const { data: session, isPending } = authClient.useSession();
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

  const refresh = useCallback(async () => {
    try {
      const storageResponse = await fetch("/api/storage", {
        cache: "no-store",
      });
      if (!storageResponse.ok)
        throw new Error("Could not load storage capacity.");
      setCapacity(await storageResponse.json());
      if (userId) {
        const response = await fetch("/api/files", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Could not load files.");
        setFiles(data.files);
      } else setFiles([]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not refresh your files.",
      );
    }
  }, [userId]);
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
    setError("");
    if (!session) {
      setAuthError("");
      setAuthOpen(true);
      return;
    }
    input.current?.click();
  }
  async function sendFile(file: File) {
    if (upload) return;
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
  const percent = capacity ? (capacity.used / capacity.total) * 100 : 0;
  return (
    <div className="site-shell">
      <header className="header wrap">
        <a href="/" className="brand" aria-label="Zora home">
          <Sun size={28} strokeWidth={1.7} />
          zora
        </a>
        <nav aria-label="Main navigation">
          <a href="#files" className="nav-link">
            Your files
          </a>
          <button className="nav-link" onClick={() => setRules(true)}>
            How it works <ArrowUpRight size={14} />
          </button>
        </nav>
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
                  setFiles([]);
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
      </header>
      <main className="wrap">
        <section className="intro" aria-labelledby="main-title">
          <div>
            <div className="eyebrow">
              <span className="status-dot" />
              Small files. Shared freely.
            </div>
            <h1 id="main-title">
              Temporary files.
              <br />
              <span>Ready to share.</span>
            </h1>
          </div>
          <p>
            A direct link for the things you need to send.
            <br />
            Up to 10 MB. Gone in 10 days.
          </p>
        </section>
        <div className="workspace">
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
                New upload
              </span>
              <span className="subtle">01 — 10 MB max</span>
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
                    : "Drop a file, get a link."}
              </h2>
              <p>
                {upload
                  ? upload.name
                  : "A photo, a clip, a recording. Make it shareable."}
              </p>
              {upload ? (
                <div className="upload-progress">
                  <div className="progress-track">
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
                  disabled={
                    isPending || (!!capacity && capacity.used >= capacity.total)
                  }
                  onClick={chooseFile}
                >
                  <Plus size={18} />
                  {capacity && capacity.used >= capacity.total
                    ? "Storage is full"
                    : "Choose a file"}
                  <ChevronRight size={15} />
                </button>
              )}
              <input
                ref={input}
                type="file"
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
                <span className="upload-hint">or drag and drop it here</span>
              )}
            </div>
            <div className="upload-bottom">
              <span>
                <Clock3 size={15} />
                Auto-expires in 10 days
              </span>
              <span>
                <ShieldCheck size={15} />
                No scripts or executables
              </span>
            </div>
          </section>
          <aside className="side-panels">
            <section
              className="capacity-panel"
              aria-labelledby="capacity-heading"
            >
              <div className="panel-label">
                <span>
                  <Globe2 size={15} />
                  Shared by everyone
                </span>
                <span className="status-dot" />
              </div>
              <h2 id="capacity-heading">
                Community
                <br />
                storage.
              </h2>
              <div className="capacity-numbers">
                <strong>{capacity ? bytes(capacity.used) : "—"}</strong>
                <span>/ 9.5 GB</span>
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
                  {capacity
                    ? `${Math.max(0, 100 - percent).toFixed(1)}% available`
                    : "Loading capacity"}
                </span>
                <span>Used + reserved</span>
              </div>
              <p>
                One community pool. Expired files make
                <br className="desktop-break" /> room for the next thing.
              </p>
            </section>
            <section className="rules-panel">
              <div className="rule-icon">
                <Link2 size={18} />
              </div>
              <div>
                <h3>One link. No extra steps.</h3>
                <p>
                  Anyone with the link can download.
                  <br />
                  No account needed to receive.
                </p>
              </div>
              <ArrowUpRight size={17} />
            </section>
          </aside>
        </div>
        {error && (
          <div className="notice error" role="alert">
            <ShieldCheck size={18} />
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
                Your files{" "}
                <span className="count">
                  {files.length.toString().padStart(2, "0")}
                </span>
              </h2>
              <p>
                {session
                  ? "A short stay. A useful link."
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
          {files.length ? (
            <div className="file-table">
              <div className="table-heading">
                <span>File</span>
                <span>Expires</span>
                <span>Share</span>
              </div>
              {files.map((file) => (
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
            </div>
          ) : (
            <div className="empty-files">
              <div className="empty-icon">
                <Link2 size={24} strokeWidth={1.4} />
              </div>
              <div>
                <h3>No files yet.</h3>
                <p>
                  {session
                    ? "Upload your first file. We’ll keep it here for 10 days."
                    : "Sign in with GitHub, upload a file, and send it on its way."}
                </p>
              </div>
              <button
                className="text-button"
                disabled={isPending}
                onClick={chooseFile}
              >
                {session ? "Add your first file" : "Get started"}
                <ArrowUpRight size={17} />
              </button>
            </div>
          )}
        </section>
        <div className="details-strip">
          <span>
            <FileImage size={15} />
            Images
          </span>
          <span>
            <FileAudio size={15} />
            Audio
          </span>
          <span>
            <FileVideo size={15} />
            Video
          </span>
          <button onClick={() => setRules(true)}>
            Supported formats <ArrowUpRight size={13} />
          </button>
          <span className="strip-note">
            Temporary by design. Share thoughtfully.
          </span>
        </div>
      </main>
      <footer className="wrap footer">
        <span className="footer-brand">
          <Sun size={17} /> zora <span>Small files, short stays.</span>
        </span>
        <button onClick={() => setReporting(true)}>
          <Flag size={13} />
          Report a file
        </button>
        <span>Built for the in-between.</span>
      </footer>
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
