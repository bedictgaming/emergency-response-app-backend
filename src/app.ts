import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import passport from '@/lib/passport';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { ENV } from '@/config/env';
import routes from '@/routes';
import { getHttpLogLevel } from '@/lib/http-log-policy';
import { originGuard } from '@/middlewares/origin-guard';
import { createApiGatewayGuard, clientIpRateLimitKey } from '@/middlewares/api-gateway';

const app = express();

app.disable('x-powered-by');
app.disable('etag');
// Trust only explicitly configured reverse-proxy addresses. A hop count lets
// direct clients spoof X-Forwarded-For and evade IP-based rate limits.
app.set('trust proxy', ENV.TRUSTED_PROXY_CIDRS.length ? ENV.TRUSTED_PROXY_CIDRS : false);
app.use((req, res, next) => {
  const requestId = req.header('x-request-id') || crypto.randomUUID();
  res.setHeader('x-request-id', requestId);
  next();
});
app.use(pinoHttp({
  autoLogging: ENV.NODE_ENV === 'test' ? false : {
    // Long-lived event streams reconnect by design and are not useful as one
    // request-completed log entry every minute.
    ignore: (req) => Boolean(req.url?.startsWith('/api/events/v1/')),
  },
  customLogLevel: (req, res, error) => {
    return getHttpLogLevel({
      method: req.method,
      url: req.url?.split('?')[0],
      statusCode: res.statusCode,
      hasError: Boolean(error),
      environment: ENV.NODE_ENV,
    });
  },
  // Authentication cookies and bearer tokens must never be written to logs.
  // The narrow serializers also keep routine request logs useful without
  // copying every browser header into stdout or a log collector.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'req.headers["x-er-gateway-signature"]',
      'req.headers["x-er-gateway-nonce"]',
    ],
    remove: true,
  },
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url?.split('?')[0],
      remoteAddress: req.remoteAddress,
    }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
}));
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());

// API responses represent live operational data and must not be served from a
// browser cache. This also prevents misleading 304 responses for incident and
// authentication requests.
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
// Root-mounted to sign/verify the original API path, including query and trailing slash.
const gatewayGuard = createApiGatewayGuard({ required: ENV.API_GATEWAY_REQUIRED,
  secret: ENV.API_GATEWAY_SECRET, audience: ENV.API_GATEWAY_AUDIENCE });
app.use((req, res, next) => (req.path === '/api' || req.path.startsWith('/api/'))
  ? gatewayGuard(req, res, next) : next());
app.use(originGuard);

// --- Core Middleware ---
app.use(cors({
  origin: ENV.FRONTEND_URL,
  credentials: true,
  // Cache successful browser preflight checks to avoid an OPTIONS request
  // before every repeated API call.
  maxAge: 86_400,
}));

app.use(express.json({ limit: '15mb' }));
app.use(cookieParser());
app.use(passport.initialize());

app.use('/api/upload', rateLimit({
  keyGenerator: clientIpRateLimitKey,
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { code: 429, status: 'error', message: 'Upload limit reached. Try again later.' },
}));

// --- Simple Health Check ---
app.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'success',
    message: `${ENV.APP_NAME} instance is healthy - 3B - New Features!`,
    timestamp: new Date().toISOString(),
    environment: ENV.NODE_ENV
  });
});

app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

app.get('/readyz', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not_ready', dependency: 'database' });
  }
});

// --- Routes Folder Prepared ---
app.use('/api', routes);

// --- 404 Handler ---
app.use((req: Request, res: Response) => {
  res.status(404).json({
    code: 404,
    status: 'error',
    message: `Cannot ${req.method} ${req.originalUrl}`
  });
});

// --- Global Error Handler ---
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('🔥 Global Error Hook:', err.message);

  const candidateStatus = Number(err.status ?? err.statusCode);
  const statusCode = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599
    ? candidateStatus
    : 500;
  const message = err.type === 'entity.parse.failed'
    ? 'Invalid JSON request body'
    : statusCode >= 500
      ? 'Internal Server Error'
      : statusCode === 413
        ? 'Request body too large'
        : 'Invalid request';
  res.status(statusCode).json({
    code: statusCode,
    status: 'error',
    message,
  });
});

export default app;
