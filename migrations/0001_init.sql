CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL DEFAULT 'running',
  candidates INTEGER,
  fresh INTEGER,
  sent INTEGER,
  terms_failed INTEGER,
  error TEXT
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  company TEXT,
  location TEXT,
  salary_min REAL,
  salary_max REAL,
  url TEXT,
  sent_at TEXT NOT NULL,
  run_id INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  status_at TEXT
);

CREATE INDEX jobs_status_sent ON jobs (status, sent_at DESC);
CREATE INDEX runs_started ON runs (started_at DESC);
