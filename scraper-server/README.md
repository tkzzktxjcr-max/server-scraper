# Scraper Server

Browser automation scraper server that writes scraped property data to Appwrite Database.

## Features

- 🌐 Scrapes property listings from Immoweb, Zimmo, and Immovlan
- ⏰ Cron-based scheduling for automated scraping
- 📊 Job queue with rate limiting
- 🗄️ Writes directly to Appwrite Database
- 🔄 Health check endpoint for monitoring

## Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your Appwrite credentials
nano .env

# Run in development mode
npm run dev
```

### Docker

```bash
# Build and run
docker-compose up -d

# View logs
docker-compose logs -f scraper-server

# Stop
docker-compose down
```

### Coolify Deployment

1. **Create a new application** in Coolify
2. **Connect your Git repository**
3. **Configure the build**:
   - Build Pack: `Dockerfile`
   - Port: `3001`
4. **Add environment variables**:
   ```
   APPWRITE_ENDPOINT=https://your-appwrite.endpoint/v1
   APPWRITE_PROJECT=your-project-id
   APPWRITE_API_KEY=your-api-key
   APPWRITE_DATABASE_ID=your-database-id
   NODE_ENV=production
   PORT=3001
   ```
5. **Deploy** 🚀

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `APPWRITE_ENDPOINT` | Yes | - | Appwrite server endpoint |
| `APPWRITE_PROJECT` | Yes | - | Appwrite project ID |
| `APPWRITE_API_KEY` | Yes | - | Appwrite API key |
| `APPWRITE_DATABASE_ID` | Yes | - | Appwrite database ID |
| `NODE_ENV` | No | `production` | Environment mode |
| `PORT` | No | `3001` | Server port |
| `BROWSER_HEADLESS` | No | `true` | Run browser in headless mode |
| `BROWSER_TIMEOUT` | No | `60000` | Browser timeout (ms) |
| `BROWSER_MAX_PAGES` | No | `5` | Max concurrent browser pages |
| `REQUEST_DELAY_MS` | No | `2000` | Delay between requests (ms) |
| `MAX_CONCURRENT_JOBS` | No | `3` | Max concurrent scraping jobs |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate limit window (ms) |
| `RATE_LIMIT_MAX_REQUESTS` | No | `10` | Max requests per window |

## API Endpoints

### Health Check
```
GET /health
```

### Scrape Jobs
```
POST /api/scrape          - Trigger a new scrape
GET  /api/scrape/status/:id - Get job status
GET  /api/scrape/queue    - Get queue status
```

### Schedules
```
GET    /api/schedules          - List all schedules
POST   /api/scrape             - Create new schedule
GET    /api/scrape/:id         - Get specific schedule
PUT    /api/scrape/:id         - Update schedule
DELETE /api/scrape/:id         - Delete schedule
PATCH  /api/scrape/:id/toggle  - Toggle schedule
POST   /api/scrape/:id/trigger  - Trigger immediately
GET    /api/scrape/status       - Get scheduler status
```

## Cron Expression Format

Schedules use standard cron format: `minute hour day month weekday`

### Presets
- `0 6 * * *` - Daily at 6 AM
- `0 0 * * *` - Daily at midnight
- `0 */12 * * *` - Every 12 hours
- `0 */6 * * *` - Every 6 hours
- `0 6 * * 0` - Weekly on Sunday

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Scraper Server                          │
├─────────────────────────────────────────────────────────────┤
│  Express API                                               │
│  ├── /api/scrape - Job management                         │
│  └── /api/schedules - Schedule management                  │
├─────────────────────────────────────────────────────────────┤
│  Scheduler (node-cron)                                     │
│  └── Triggers jobs based on cron expressions               │
├─────────────────────────────────────────────────────────────┤
│  Job Queue                                                 │
│  └── Manages concurrent scraping jobs                       │
├─────────────────────────────────────────────────────────────┤
│  Browser Pool (Puppeteer)                                  │
│  └── Handles browser automation                            │
├─────────────────────────────────────────────────────────────┤
│  Scrapers                                                  │
│  ├── immoweb.ts                                           │
│  ├── zimmo.ts                                             │
│  └── immovlan.ts                                          │
├─────────────────────────────────────────────────────────────┤
│  Appwrite Client                                           │
│  └── Writes data to Appwrite Database                      │
└─────────────────────────────────────────────────────────────┘
```

## License

MIT