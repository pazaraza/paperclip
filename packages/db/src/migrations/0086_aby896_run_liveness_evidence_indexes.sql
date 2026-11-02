CREATE INDEX IF NOT EXISTS "heartbeat_runs_status_finished_idx" ON "heartbeat_runs" USING btree ("status", "finished_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_comments_created_by_run_idx" ON "issue_comments" USING btree ("created_by_run_id", "company_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_work_products_created_by_run_idx" ON "issue_work_products" USING btree ("created_by_run_id", "company_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_revisions_created_by_run_idx" ON "document_revisions" USING btree ("created_by_run_id", "company_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_log_action_run_idx" ON "activity_log" USING btree ("action", "run_id");