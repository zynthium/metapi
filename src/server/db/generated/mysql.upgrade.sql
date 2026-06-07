ALTER TABLE `account_tokens` ADD COLUMN `upstream_token_id` TEXT;
ALTER TABLE `account_tokens` ADD COLUMN `upstream_created_at` VARCHAR(191);
CREATE INDEX `account_tokens_account_upstream_token_idx` ON `account_tokens` (`account_id`, `upstream_token_id`(191));
