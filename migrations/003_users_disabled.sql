-- Admins can disable a user (keeps their history): no login, sessions revoked, not a tester in game.
ALTER TABLE users ADD COLUMN disabled TINYINT NOT NULL DEFAULT 0, ADD COLUMN disabled_at BIGINT NULL;
