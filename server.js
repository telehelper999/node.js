#!/usr/bin/env node
/**
 * Scalable Node.js Socket.IO Server with Redis Pub/Sub
 * Designed for VPS deployment with thousands of concurrent connections
 */

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('redis');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const server = createServer(app);

// ⬇️ SECURITY & PERFORMANCE MIDDLEWARE
app.use(helmet({
    contentSecurityPolicy: false // Allow WebSocket connections
}));

app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || "*",
    credentials: true
}));

// Rate limiting for HTTP endpoints
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP'
});
app.use(limiter);

// ⬇️ REDIS CONFIGURATION FOR SCALING
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

// Create Redis clients for Socket.IO adapter
const pubClient = Redis.createClient({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
    retryDelayOnFailover: 100,
    enableReadyCheck: false,
    maxRetriesPerRequest: null
});

const subClient = pubClient.duplicate();

// ⬇️ SOCKET.IO SERVER WITH REDIS ADAPTER
const io = new Server(server, {
    cors: {
        origin: process.env.ALLOWED_ORIGINS?.split(',') || "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    // Performance optimizations for VPS
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e6, // 1MB
    allowEIO3: true,
    transports: ['websocket', 'polling']
});

// Redis adapter for multi-instance scaling
let redisConnected = false;

async function setupRedisAdapter() {
    try {
        await pubClient.connect();
        await subClient.connect();
        
        io.adapter(createAdapter(pubClient, subClient));
        redisConnected = true;
        
        console.log('✅ Redis adapter connected - multi-instance scaling enabled');
        
        // Subscribe to bonus codes from Python backend
        await subClient.subscribe('bonus_codes', (message) => {
            try {
                const codeData = JSON.parse(message);
                console.log(`📡 Broadcasting code ${codeData.code} to all clients`);
                
                // Broadcast to all connected clients across all instances
                io.emit('bonus_code', {
                    ...codeData,
                    server_id: process.env.SERVER_ID || 'main',
                    broadcast_time: Date.now()
                });
                
                // Update statistics
                updateStats('codes_broadcasted');
                
            } catch (error) {
                console.error('❌ Error processing Redis message:', error);
            }
        });
        
    } catch (error) {
        console.error('⚠️ Redis adapter setup failed:', error);
        console.log('🔄 Running in single-instance mode');
    }
}

// ⬇️ CONNECTION MANAGEMENT & RATE LIMITING
const connectionStats = {
    total_connections: 0,
    active_connections: 0,
    codes_broadcasted: 0,
    messages_sent: 0,
    start_time: Date.now()
};

const userRateLimits = new Map(); // Rate limiting per user
const CONNECTION_RATE_LIMIT = 5; // Max connections per minute per IP
const MESSAGE_RATE_LIMIT = 10; // Max messages per minute per user

function updateStats(metric, delta = 1) {
    if (connectionStats[metric] !== undefined) {
        connectionStats[metric] += delta;
    }
}

function checkRateLimit(userId, type = 'message') {
    const now = Date.now();
    const key = `${userId}_${type}`;
    
    if (!userRateLimits.has(key)) {
        userRateLimits.set(key, { count: 1, resetTime: now + 60000 });
        return true;
    }
    
    const limit = userRateLimits.get(key);
    
    if (now > limit.resetTime) {
        limit.count = 1;
        limit.resetTime = now + 60000;
        return true;
    }
    
    const maxLimit = type === 'connection' ? CONNECTION_RATE_LIMIT : MESSAGE_RATE_LIMIT;
    
    if (limit.count >= maxLimit) {
        return false;
    }
    
    limit.count++;
    return true;
}

// ⬇️ SOCKET.IO EVENT HANDLERS
io.on('connection', (socket) => {
    const clientIp = socket.handshake.address;
    const userId = socket.handshake.query.userId || socket.id;
    
    // Rate limit connections
    if (!checkRateLimit(clientIp, 'connection')) {
        console.log(`🚫 Connection rate limit exceeded for ${clientIp}`);
        socket.emit('error', { message: 'Connection rate limit exceeded' });
        socket.disconnect(true);
        return;
    }
    
    updateStats('total_connections');
    updateStats('active_connections');
    
    console.log(`🔌 Client connected: ${socket.id} (${clientIp}) - Active: ${connectionStats.active_connections}`);
    
    // Send welcome message with server info
    socket.emit('welcome', {
        server_id: process.env.SERVER_ID || 'main',
        redis_enabled: redisConnected,
        connection_time: Date.now(),
        rate_limits: {
            messages_per_minute: MESSAGE_RATE_LIMIT,
            connections_per_minute: CONNECTION_RATE_LIMIT
        }
    });
    
    // ⬇️ HEARTBEAT IMPLEMENTATION
    socket.on('ping', (callback) => {
        if (typeof callback === 'function') {
            callback({
                server_time: Date.now(),
                server_id: process.env.SERVER_ID || 'main'
            });
        }
    });
    
    // ⬇️ USER AUTHENTICATION & IDENTIFICATION
    socket.on('authenticate', (data) => {
        if (!checkRateLimit(userId, 'message')) {
            socket.emit('error', { message: 'Message rate limit exceeded' });
            return;
        }
        
        const { username, token } = data;
        
        // Basic validation (replace with your auth logic)
        if (username && username.length >= 3) {
            socket.userId = username;
            socket.authenticated = true;
            socket.join(`user_${username}`);
            
            console.log(`✅ User authenticated: ${username} (${socket.id})`);
            
            socket.emit('authenticated', {
                username,
                server_id: process.env.SERVER_ID || 'main',
                time: Date.now()
            });
            
            // Send recent codes if available (last 10 codes)
            if (redisConnected) {
                sendRecentCodes(socket);
            }
        } else {
            socket.emit('auth_error', { message: 'Invalid username' });
        }
    });
    
    // ⬇️ CODE CLAIMING WITH RATE LIMITING
    socket.on('claim_code', (data) => {
        if (!socket.authenticated) {
            socket.emit('error', { message: 'Authentication required' });
            return;
        }
        
        if (!checkRateLimit(socket.userId, 'message')) {
            socket.emit('error', { message: 'Rate limit exceeded - slow down!' });
            return;
        }
        
        const { code, auto_claim = false } = data;
        
        console.log(`🎯 Code claim attempt: ${code} by ${socket.userId} (auto: ${auto_claim})`);
        
        // Emit to user's personal room and broadcast to others
        socket.emit('claim_received', {
            code,
            user: socket.userId,
            time: Date.now(),
            auto_claim
        });
        
        // Broadcast to other users that this code was claimed
        socket.broadcast.emit('code_claimed', {
            code,
            claimed_by: socket.userId,
            time: Date.now()
        });
        
        updateStats('messages_sent');
    });
    
    // ⬇️ DISCONNECT HANDLING
    socket.on('disconnect', (reason) => {
        updateStats('active_connections', -1);
        console.log(`🔌 Client disconnected: ${socket.id} (${reason}) - Active: ${connectionStats.active_connections}`);
    });
    
    // Error handling
    socket.on('error', (error) => {
        console.error(`❌ Socket error for ${socket.id}:`, error);
    });
});

// ⬇️ HELPER FUNCTIONS
async function sendRecentCodes(socket) {
    try {
        // Get recent codes from Redis (if available)
        const recentCodes = await pubClient.lRange('recent_codes', 0, 9);
        
        if (recentCodes.length > 0) {
            socket.emit('recent_codes', {
                codes: recentCodes.map(code => JSON.parse(code)),
                count: recentCodes.length
            });
        }
    } catch (error) {
        console.error('Error fetching recent codes:', error);
    }
}

// ⬇️ HTTP ENDPOINTS FOR MONITORING
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: Date.now() - connectionStats.start_time,
        redis_connected: redisConnected,
        stats: connectionStats,
        server_id: process.env.SERVER_ID || 'main'
    });
});

app.get('/stats', (req, res) => {
    res.json({
        ...connectionStats,
        uptime: Date.now() - connectionStats.start_time,
        redis_status: redisConnected,
        rate_limits: {
            connections_per_minute: CONNECTION_RATE_LIMIT,
            messages_per_minute: MESSAGE_RATE_LIMIT
        }
    });
});

// ⬇️ SERVER STARTUP
const PORT = process.env.SOCKETIO_PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

async function startServer() {
    try {
        // Setup Redis adapter first
        await setupRedisAdapter();
        
        // Start HTTP server
        server.listen(PORT, HOST, () => {
            console.log('🚀 Socket.IO Server Started Successfully!');
            console.log('=' .repeat(50));
            console.log(`📡 Server URL: http://${HOST}:${PORT}`);
            console.log(`🔐 Redis Auth: ${REDIS_PASSWORD ? 'Enabled' : 'Disabled'}`);
            console.log(`⚡ Multi-instance: ${redisConnected ? 'Enabled' : 'Disabled'}`);
            console.log(`🛡️ Rate Limiting: Enabled`);
            console.log(`💓 Heartbeat: 25s interval, 60s timeout`);
            console.log('=' .repeat(50));
            console.log('Ready for VPS deployment with Nginx reverse proxy');
            console.log('Configure Nginx: http://your-domain.com → ws://127.0.0.1:3001');
        });
        
        // Graceful shutdown
        process.on('SIGTERM', () => {
            console.log('🔄 Graceful shutdown initiated...');
            server.close(() => {
                if (redisConnected) {
                    pubClient.quit();
                    subClient.quit();
                }
                process.exit(0);
            });
        });
        
    } catch (error) {
        console.error('❌ Server startup failed:', error);
        process.exit(1);
    }
}

startServer();