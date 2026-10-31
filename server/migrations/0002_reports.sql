CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  email TEXT,
  reason TEXT,
  note TEXT,
  content TEXT,
  created INTEGER
);
CREATE INDEX IF NOT EXISTS reports_created ON reports(created);
