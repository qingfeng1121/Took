const port = process.argv[2] || "8420";
const res = await fetch(`http://127.0.0.1:${port}/api/sync/pull?since=0`);
const body = await res.json();
console.log("SERVER", JSON.stringify({
  maxRev: body.maxRev,
  completions: (body.completions || []).map((c) => ({
    key: c.task_id + "|" + c.period_start,
    status: c.status,
    rev: c.rev,
    updated_at: c.updated_at,
  })),
}));
