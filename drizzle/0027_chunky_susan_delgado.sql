CREATE TABLE `account_group_ratios` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`site_id` integer NOT NULL,
	`group_name` text NOT NULL,
	`multiplier` real NOT NULL,
	`refreshed_at` text,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "account_group_ratios_multiplier_positive" CHECK("account_group_ratios"."multiplier" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_group_ratios_account_site_group_unique` ON `account_group_ratios` (`account_id`,`site_id`,`group_name`);--> statement-breakpoint
CREATE INDEX `account_group_ratios_account_site_idx` ON `account_group_ratios` (`account_id`,`site_id`);--> statement-breakpoint
CREATE INDEX `account_group_ratios_site_group_idx` ON `account_group_ratios` (`site_id`,`group_name`);
