require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const { rateLimit } = require('express-rate-limit');
const Redis = require('ioredis');
const { PrismaClient } = require('@prisma/client');
const logger = require('./utils/logger');

// Initialize Prisma
const prisma = new PrismaClient({
  log: ['query', 'error', 'warn'],
});

// Initialize Redis
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error', (err) => logger.error('Redis error:', err));

// Initialize Express
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

// Make prisma, redis, and io available to routes
app.set('prisma', prisma);
app.set('redis', redis);
app.set('io', io);

// Security Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));

// Body Parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Compression
app.use(compression());

// Logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', limiter);

// Health Check
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await redis.ping();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        redis: 'connected',
        server: 'running',
      },
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      message: 'Service unavailable',
      error: error.message,
    });
  }
});

// API Routes
app.use('/api/v1/auth', require('./routes/auth.routes'));
app.use('/api/v1/users', require('./routes/user.routes'));
app.use('/api/v1/locations', require('./routes/location.routes'));
app.use('/api/v1/tables', require('./routes/table.routes'));
app.use('/api/v1/categories', require('./routes/category.routes'));
app.use('/api/v1/menu-items', require('./routes/menuItem.routes'));
app.use('/api/v1/orders', require('./routes/order.routes'));
app.use('/api/v1/payments', require('./routes/payment.routes'));
app.use('/api/v1/coupons', require('./routes/coupon.routes'));
app.use('/api/v1/loyalty', require('./routes/loyalty.routes'));
app.use('/api/v1/reservations', require('./routes/reservation.routes'));
app.use('/api/v1/deliveries', require('./routes/delivery.routes'));
app.use('/api/v1/reports', require('./routes/report.routes'));
app.use('/api/v1/settings', require('./routes/setting.routes'));

// WebSocket Authentication
const socketAuth = require('./middleware/socketAuth');
io.use(socketAuth);

// WebSocket Connection Handler
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id} - User: ${socket.user?.name}`);

  // Subscribe to location updates
  socket.on('subscribe', ({ location_id }) => {
    if (location_id) {
      socket.join(`location:${location_id}`);
      logger.info(`Socket ${socket.id} subscribed to location ${location_id}`);
    }
  });

  // Subscribe to order updates
  socket.on('subscribe:order', ({ order_id }) => {
    if (order_id) {
      socket.join(`order:${order_id}`);
      logger.info(`Socket ${socket.id} subscribed to order ${order_id}`);
    }
  });

  // Subscribe to table updates
  socket.on('subscribe:table', ({ table_id }) => {
    if (table_id) {
      socket.join(`table:${table_id}`);
      logger.info(`Socket ${socket.id} subscribed to table ${table_id}`);
    }
  });

  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found',
    },
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);

  // Prisma errors
  if (err.code === 'P2002') {
    return res.status(409).json({
      success: false,
      error: {
        code: 'DUPLICATE_ENTRY',
        message: 'A record with this value already exists',
        field: err.meta?.target,
      },
    });
  }

  if (err.code === 'P2025') {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Record not found',
      },
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_TOKEN',
        message: 'Invalid authentication token',
      },
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      error: {
        code: 'TOKEN_EXPIRED',
        message: 'Authentication token has expired',
      },
    });
  }

  // Validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: err.message,
        details: err.details,
      },
    });
  }

  // Default error
  res.status(err.status || 500).json({
    success: false,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    },
  });
});

// Graceful Shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await prisma.$disconnect();
  await redis.quit();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await prisma.$disconnect();
  await redis.quit();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
  logger.info(`📡 WebSocket server ready`);
  logger.info(`🔗 API: http://localhost:${PORT}/api/v1`);
  logger.info(`💚 Health: http://localhost:${PORT}/health`);
});

module.exports = { app, server, io, prisma, redis };