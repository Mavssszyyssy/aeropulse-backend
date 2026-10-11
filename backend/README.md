# AeroPulse Backend

Express + MongoDB backend API for web and mobile clients. It is ready to deploy as a standalone Vercel repository.

## Setup

1. Copy `.env.example` to `.env`
2. Update `MONGODB_URI` and `JWT_SECRET`
3. Install dependencies:
   - `npm install`
4. Seed demo users (optional):
   - `npm run seed`
5. Run backend:
   - `npm run dev`

## API Base URL

- `http://localhost:5000/api`

## Deploy to Vercel

Deploy the `backend` folder as the repository root. Vercel uses `api/index.js` as the serverless entry and rewrites every request to the Express app.

Set these Vercel environment variables for Production, Preview, and Development as appropriate:

- `NODE_ENV=production`
- `MONGODB_URI` — MongoDB Atlas connection string
- `JWT_SECRET` — a long random secret
- `CORS_ORIGIN` — comma-separated allowed web origins, for example `https://your-web-app.vercel.app`
- `FRONTEND_URL` — primary web application URL
- `BACKEND_PUBLIC_URL` — deployed backend URL, for example `https://your-backend.vercel.app`
- Payment/email provider settings only when those features are enabled.

Allow Vercel's outbound access in MongoDB Atlas Network Access (or use Atlas's secure access mechanism). After deployment, verify:

- `https://your-backend.vercel.app/api/health`

The expected response includes `"status":"ok"`.

## Auth Endpoints

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`

## User Endpoints (Bearer token required)

- `PATCH /api/users/profile`
- `PATCH /api/users/preferences`
- `PATCH /api/users/privacy`
- `PATCH /api/users/notifications`
- `PATCH /api/users/password`
- `DELETE /api/users/me`

## AI maintenance decision support

Set `OPENAI_API_KEY` **only on the backend** to enable on-demand pre-visit and post-visit assessments. The existing `OPENAI_MODEL`, `OPENAI_BASE_URL`, `OPENAI_TIMEOUT_MS`, and `OPENAI_MAX_OUTPUT_TOKENS` settings also apply; these larger structured responses reserve at least 1,800 output tokens. No mobile or web API key is needed. Without a configured provider, generation reports an unavailable state and never substitutes a fabricated AI answer.

- Admin/SuperAdmin: `POST /api/amp/requests/:requestId/pre-assessment` on an open service request.
- Assigned technician or authorized admin: `GET /api/amp/tasks/:taskId/decision-support`, `POST /api/amp/tasks/:taskId/pre-assessment`, and (after a completed work order and saved service history) `POST /api/amp/tasks/:taskId/future-prediction`.
- Primary assigned technician: `PATCH /api/amp/tasks/:taskId/:phase/review` with `phase` = `pre` or `post` and `decision` = `confirmed` or `rejected`.

Pre-visit output is saved separately on the service request; post-visit output is saved separately on its linked service-history record. Existing technician notes, parts-used records, AMP schedules, and inventory are unchanged. The optional English interpretation does not replace original Tagalog/Taglish notes. These assessments are qualitative decision support, not a statistical failure forecast, confirmed diagnosis, booking, or permission to replace a component. No schema migration is needed for existing MongoDB documents; the new fields default to null.
