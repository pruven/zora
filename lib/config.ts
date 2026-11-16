export const MAX_FILE_BYTES = 10_000_000;
export const GLOBAL_BYTES = 9_500_000_000; // headroom below the provider's 10 GB allowance
export const USER_BYTES = 100_000_000;
export const DAILY_UPLOADS = 20;
export const RETENTION_MS = 10 * 24 * 60 * 60 * 1000;
export const ACCEPT = ".jpg,.jpeg,.png,.webp,.mp3,.wav,.mp4,.webm,.ogg,.flac";
export const appURL = () =>
  process.env.BETTER_AUTH_URL || "http://localhost:3000";
