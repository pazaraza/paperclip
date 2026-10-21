-- Add per-agent wake-attempt recording to agent_runtime_state so the
-- fleet-health watch can detect assignment-wake contention that left the
-- last run path clean. See RUAAAAA-5205.
--
-- last_wake_error: short failure reason captured from a rejected assignment
-- wake (notably the issues_open_routine_execution_uq contention). Distinct
-- from last_error, which is reserved for run-time failures.
--
-- last_wake_attempted_at: timestamp of the most recent wake attempt,
-- success or failure. Lets the watch bound the staleness check.

DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public'
		  AND table_name = 'agent_runtime_state'
		  AND column_name = 'last_wake_error'
	) THEN
		ALTER TABLE "agent_runtime_state" ADD COLUMN "last_wake_error" text;
	END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public'
		  AND table_name = 'agent_runtime_state'
		  AND column_name = 'last_wake_attempted_at'
	) THEN
		ALTER TABLE "agent_runtime_state" ADD COLUMN "last_wake_attempted_at" timestamp with time zone;
	END IF;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "agent_runtime_state_last_wake_error_idx"
	ON "agent_runtime_state" USING btree ("last_wake_attempted_at")
	WHERE "agent_runtime_state"."last_wake_error" IS NOT NULL;
