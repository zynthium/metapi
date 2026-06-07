ALTER TABLE `account_tokens` ADD `upstream_token_id` text;--> statement-breakpoint
ALTER TABLE `account_tokens` ADD `upstream_created_at` text;--> statement-breakpoint
CREATE INDEX `account_tokens_account_upstream_token_idx` ON `account_tokens` (`account_id`,`upstream_token_id`);