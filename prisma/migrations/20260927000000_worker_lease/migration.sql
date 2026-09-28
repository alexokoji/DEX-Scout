-- Short-lived lease used by serverless cron jobs to avoid overlapping runs.
ALTER TABLE "WorkerState" ADD COLUMN "leaseUntil" TIMESTAMP(3);
