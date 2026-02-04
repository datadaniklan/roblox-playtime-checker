import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => res.send("OK - Playtime Checker running ✅"));

async function fetchJson(url, options = {}) {
  const r = await fetch(url, options);
  const txt = await r.text();
  let data = null;
  try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function usernameToUserId(username) {
  const data = await fetchJson("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true })
  });
  return data?.data?.[0]?.id || null;
}

async function getAllUserBadges(userId, limitPages = 10) {
  let cursor = "";
  const all = [];
  for (let i = 0; i < limitPages; i++) {
    const url =
      `https://badges.roblox.com/v1/users/${userId}/badges?limit=100&sortOrder=Asc` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const data = await fetchJson(url);
    all.push(...(data?.data || []));
    cursor = data?.nextPageCursor;
    if (!cursor) break;
  }
  return all;
}

async function getBadgesInfo(badgeIds) {
  const map = new Map();
  const chunk = 50;
  for (let i = 0; i < badgeIds.length; i += chunk) {
    const part = badgeIds.slice(i, i + chunk);
    const url = `https://badges.roblox.com/v1/badges?badgeIds=${part.join(",")}`;
    const data = await fetchJson(url);
    for (const b of (data?.data || [])) {
      if (b?.id) map.set(String(b.id), b);
    }
  }
  return map;
}

async function getUniverseNames(universeIds) {
  const map = new Map();
  const chunk = 50;
  for (let i = 0; i < universeIds.length; i += chunk) {
    const part = universeIds.slice(i, i + chunk);
    const url = `https://games.roblox.com/v1/games?universeIds=${part.join(",")}`;
    const data = await fetchJson(url);
    for (const g of (data?.data || [])) {
      if (g?.id) map.set(String(g.id), g.name || `Universe ${g.id}`);
    }
  }
  return map;
}

// ====== Estimator settings ======
const MINUTES_PER_BADGE = 6; // small so it doesn't lie too hard
const MAX_BADGES_USED = 300; // cap per game

function estimateHoursFromBadgeCount(badgeCount) {
  const used = Math.min(badgeCount, MAX_BADGES_USED);
  const minutes = used * MINUTES_PER_BADGE;
  return Math.round((minutes / 60) * 10) / 10; // 1 decimal
}

app.post("/playtime-estimate", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    if (!username) return res.json({ ok: false, error: "Missing username" });

    const userId = await usernameToUserId(username);
    if (!userId) return res.json({ ok: false, error: "User not found" });

    const awards = await getAllUserBadges(userId, 12);
    const badgeIds = [...new Set(awards.map(a => String(a.badgeId)).filter(Boolean))];

    const badgeInfo = await getBadgesInfo(badgeIds);

    const byUniverse = new Map(); // universeId -> badgeCount
    for (const award of awards) {
      const bid = String(award.badgeId);
      const info = badgeInfo.get(bid);
      const universeId = info?.awardingUniverse?.id;
      if (!universeId) continue;

      const key = String(universeId);
      byUniverse.set(key, (byUniverse.get(key) || 0) + 1);
    }

    const universeIds = [...byUniverse.keys()];
    const names = await getUniverseNames(universeIds);

    const games = universeIds.map((uni) => {
      const badges = byUniverse.get(uni) || 0;
      const hours = estimateHoursFromBadgeCount(badges);
      return {
        universeId: Number(uni),
        name: names.get(uni) || `Universe ${uni}`,
        badges,
        estimatedHours: hours,
        confidence: "low"
      };
    }).sort((a, b) => b.estimatedHours - a.estimatedHours);

    const totalEstimatedHours =
      Math.round(games.reduce((s, g) => s + g.estimatedHours, 0) * 10) / 10;

    return res.json({
      ok: true,
      username,
      userId,
      totalEstimatedHours,
      games: games.slice(0, 20),
      note: "Estimate based on public badge counts. Roblox does NOT provide real hours played."
    });
  } catch (e) {
    console.log("[ERROR]", e);
    return res.json({ ok: false, error: String(e.message || e) });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Playtime Checker running on port", port));
