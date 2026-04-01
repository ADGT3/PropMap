# Vercel Deployment Setup

## 1. Push to GitHub
Create a GitHub repo and push all files including the new `api/` folder and `vercel.json`.

## 2. Import to Vercel
- Go to vercel.com → New Project → Import your GitHub repo
- Vercel will auto-detect the config from `vercel.json`

## 3. Add Vercel Postgres
- In your Vercel project dashboard → **Storage** tab → **Create Database** → **Postgres**
- Name it (e.g. `property-pipeline`) → Create
- Click **Connect to Project** → select your project
- Vercel automatically injects `POSTGRES_URL` as an environment variable

## 4. Deploy
- Push any commit — Vercel auto-deploys
- The `/api/pipeline` route will create the database table automatically on first request

## 5. Local development
Install dependencies for local API testing:
```bash
npm install @vercel/postgres
npm install -g vercel
vercel dev   # runs the app + API locally with your DB credentials
```

## How it works
| Action | What happens |
|---|---|
| App loads | Fetches all pipeline data from `/api/pipeline` (Postgres) |
| Card added/edited | Saves to Postgres + localStorage cache |
| Card deleted | Deletes from Postgres + localStorage cache |
| Offline / API down | Falls back to localStorage automatically |
| New code deployed | Data is safe in Postgres — not lost |

## Database schema
```sql
CREATE TABLE pipeline (
  id          TEXT PRIMARY KEY,      -- property id (e.g. "1", "search-1234")
  data        JSONB NOT NULL,        -- full pipeline entry as JSON
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
```
