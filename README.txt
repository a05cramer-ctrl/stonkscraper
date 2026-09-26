QUOTE ARRIVALS - the watcher as a website (runs 24/7, PC can be off)

Phone topic (ntfy):  stonkq-79e0faf6a664

SETUP
1. New PRIVATE GitHub repo -> upload everything in this folder. Keep the "api" folder as a folder.
2. Vercel -> Add New -> Project -> import the repo -> Framework: Other -> Deploy.
3. Vercel project -> Settings -> Environment Variables -> add  WATCH_KEY = YOUR_KEY
4. Vercel project -> Storage -> Create Database -> Upstash for Redis -> Free -> connect it to this project.
5. Deployments -> ... on the latest -> Redeploy.
6. Settings -> Domains -> add your domain.
7. cron-job.org -> free account -> Create cronjob
   URL:  https://YOURDOMAIN/api/check?key=YOUR_KEY
   Schedule: every 1 minute -> Create.
8. Open  https://YOURDOMAIN/?key=YOUR_KEY  once (it remembers the key) -> Send test ping.
9. Phone: ntfy app -> + -> stonkq-79e0faf6a664 (skip if already subscribed).
10. Close the PC watcher (START.bat) or you get every ping twice.

THE BOARD
Likely next = tokens StonkFun doesn't list yet, ranked by how likely they are to be next. Top 15 goes
              to Discord every day at 09:00 ET (DIGEST_HOUR_ET). "Send digest now" sends it right away.
Arriving  = EARLY rows (see below), then tokens Raydium has set up as a launch quote that StonkFun
            doesn't list yet. Build the coin.
Boarding  = on StonkFun's list, not launchable yet. Build the coin.
Landed    = launchable now.
On radar  = new $500K+ Raydium pool StonkFun doesn't have. Early, can be noise.

EARLY PINGS (sources that move before StonkFun)
Live on Sunrise      Sunrise put a token live. StonkFun lists Sunrise assets 2-10 min later.
Sunrise scheduled    Sunrise shows a listing with a future go-live time (exact time in the ping).
SOON on StonkFun     StonkFun's launch page shows a quote as SOON (admin-only for now).
Top StonkFun launch  A StonkFun launch above $5M market cap that isn't a quote yet (SF_PROMOTE_MCAP).
Backpack switched on Backpack enabled deposits/withdrawals for a stock that isn't on Sunrise yet.
Each ping says how early that kind of ping usually is; the watcher learns it from its own pings.

OPTIONAL ENV VARS
WATCH_NEW_POOL_TVL = 0      turns "On radar" pings off (default 500000)
DIGEST_HOUR_ET = 9          hour (New York) of the daily Likely next digest, -1 = off
SF_PROMOTE_MCAP = 5000000   market cap where a StonkFun launch counts as "about to become a quote"
NTFY_TOPIC = your-topic     change the phone topic
