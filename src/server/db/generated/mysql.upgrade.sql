CREATE TABLE IF NOT EXISTS `account_token_health` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `token_id` INT NOT NULL, `status` VARCHAR(191) NOT NULL DEFAULT 'unknown', `last_success_at` VARCHAR(191), `last_failure_at` VARCHAR(191), `last_probe_at` VARCHAR(191), `last_probe_model` TEXT, `last_used_model` TEXT, `last_error` TEXT, `failure_count` INT NOT NULL DEFAULT 0, `next_probe_at` VARCHAR(191), `updated_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')), FOREIGN KEY (`token_id`) REFERENCES `account_tokens`(`id`) ON DELETE CASCADE);
ALTER TABLE `account_tokens` ADD COLUMN `probe_model` TEXT;
ALTER TABLE `sites` ADD COLUMN `token_health_probe_model` TEXT;
CREATE UNIQUE INDEX `account_token_health_token_unique` ON `account_token_health` (`token_id`);
CREATE INDEX `account_token_health_next_probe_idx` ON `account_token_health` (`next_probe_at`);
CREATE INDEX `account_token_health_status_idx` ON `account_token_health` (`status`(191));
