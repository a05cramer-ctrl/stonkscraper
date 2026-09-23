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
Arriving  = Raydium has set it up as a launch quote, StonkFun doesn't list it yet. Build the coin.
Boarding  = on StonkFun's list, not launchable yet. Build the coin.
Landed    = launchable now.
On radar  = new $500K+ Raydium pool StonkFun doesn't have. Early, can be noise.

OPTIONAL ENV VARS
WATCH_NEW_POOL_TVL = 0      turns "On radar" pings off (default 500000)
NTFY_TOPIC = your-topic     change the phone topic
