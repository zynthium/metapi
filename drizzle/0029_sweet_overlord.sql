CREATE TABLE `account_token_health` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_id` integer NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`last_success_at` text,
	`last_failure_at` text,
	`last_probe_at` text,
	`last_probe_model` text,
	`last_used_model` text,
	`last_error` text,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`next_probe_at` text,
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`token_id`) REFERENCES `account_tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_token_health_token_unique` ON `account_token_health` (`token_id`);--> statement-breakpoint
CREATE INDEX `account_token_health_status_idx` ON `account_token_health` (`status`);--> statement-breakpoint
CREATE INDEX `account_token_health_next_probe_idx` ON `account_token_health` (`next_probe_at`);--> statement-breakpoint
ALTER TABLE `account_tokens` ADD `probe_model` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `token_health_probe_model` text;