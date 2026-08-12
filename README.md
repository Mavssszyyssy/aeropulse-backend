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
