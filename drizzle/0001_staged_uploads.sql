ALTER TABLE "files" DROP CONSTRAINT "files_valid_status";--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "reserved_bytes" bigint;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "staging_size" bigint;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "upload_expires_at" bigint;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "processing_at" bigint;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "object_key" text;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_valid_status" CHECK ("files"."status" in ('pending', 'processing', 'ready', 'deleting'));