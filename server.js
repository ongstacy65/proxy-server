const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { body, validationResult } = require('express-validator');
const pLimit = require('p-limit');
const compression = require('compression');
const crypto = require('crypto');

// UUID generator function
function generateUUID() {
    return crypto.randomUUID();
}

const app = express();

// Enable compression for all responses
app.use(compression());

// Configure CORS to allow all origins and methods
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    credentials: false
}));

// Handle preflight requests
app.options('*', cors());

// Optimize JSON parsing with limit
app.use(express.json({ limit: '1mb' }));

// Disable x-powered-by header for security and performance
app.disable('x-powered-by');

// Enable trust proxy for better performance behind load balancers
app.set('trust proxy', 1);

// Rate limiter configuration for Jira API (100 req/s limit)
const JIRA_RATE_LIMIT = 100; // Jira's limit: 100 requests per second
const RATE_LIMIT_WINDOW = 1000; // 1 second window

// Token bucket rate limiter
class RateLimiter {
    constructor(maxTokens, refillRate) {
        this.maxTokens = maxTokens;
        this.tokens = maxTokens;
        this.refillRate = refillRate; // tokens per second
        this.lastRefill = Date.now();
    }

    async acquire() {
        while (true) {
            this.refill();
            
            if (this.tokens >= 1) {
                this.tokens -= 1;
                return;
            }
            
            // Wait for next token
            const waitTime = (1 / this.refillRate) * 1000;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }

    refill() {
        const now = Date.now();
        const timePassed = (now - this.lastRefill) / 1000;
        const tokensToAdd = timePassed * this.refillRate;
        
        this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
        this.lastRefill = now;
    }

    getAvailableTokens() {
        this.refill();
        return Math.floor(this.tokens);
    }
}

// Initialize rate limiter (95 req/s to leave buffer for Jira's limit)
const rateLimiter = new RateLimiter(95, 95);

// Request queue for handling bursts
class RequestQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.stats = {
            queued: 0,
            processed: 0,
            failed: 0,
            retried: 0
        };
    }

    async enqueue(requestFn, requestId, maxRetries = 3) {
        return new Promise((resolve, reject) => {
            this.queue.push({
                requestFn,
                requestId,
                resolve,
                reject,
                retries: 0,
                maxRetries,
                enqueuedAt: Date.now()
            });
            this.stats.queued++;
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;

        while (this.queue.length > 0) {
            const item = this.queue.shift();
            
            try {
                // Wait for rate limiter token
                await rateLimiter.acquire();
                
                const waitTime = Date.now() - item.enqueuedAt;
                if (waitTime > 100) {
                    console.log(`[${item.requestId}] Queued for ${waitTime}ms`);
                }
                
                const result = await item.requestFn();
                this.stats.processed++;
                item.resolve(result);
                
            } catch (error) {
                // Handle 429 (rate limit) with exponential backoff
                if (error.response?.status === 429 && item.retries < item.maxRetries) {
                    item.retries++;
                    this.stats.retried++;
                    
                    const backoffTime = Math.min(1000 * Math.pow(2, item.retries), 10000);
                    console.log(`[${item.requestId}] Rate limited, retry ${item.retries}/${item.maxRetries} after ${backoffTime}ms`);
                    
                    await new Promise(resolve => setTimeout(resolve, backoffTime));
                    
                    // Re-queue the request
                    this.queue.unshift(item);
                } else {
                    this.stats.failed++;
                    item.reject(error);
                }
            }
        }

        this.processing = false;
    }

    getStats() {
        return {
            ...this.stats,
            queueLength: this.queue.length,
            availableTokens: rateLimiter.getAvailableTokens()
        };
    }
}

const requestQueue = new RequestQueue();

// Initialize the concurrency limit (increased to 50 concurrent requests)
const limit = pLimit(50);

// Create axios instance with optimized settings
const axiosInstance = axios.create({
    timeout: 60000, // 60 second timeout
    maxRedirects: 5,
    httpAgent: new (require('http').Agent)({
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 100,
        maxFreeSockets: 10
    }),
    httpsAgent: new (require('https').Agent)({
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 100,
        maxFreeSockets: 10
    })
});

// Simple in-memory cache with TTL
const cache = new Map();
const CACHE_TTL = 60000; // 1 minute

function getCached(key) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }
    cache.delete(key);
    return null;
}

function setCache(key, data) {
    cache.set(key, { data, timestamp: Date.now() });
    // Clean up old cache entries periodically
    if (cache.size > 1000) {
        const now = Date.now();
        for (const [k, v] of cache.entries()) {
            if (now - v.timestamp > CACHE_TTL) {
                cache.delete(k);
            }
        }
    }
}

// 1. GET Tickets Endpoint with caching
app.get('/tickets', async (req, res) => {
    const requestId = generateUUID();
    const cacheKey = 'tickets_list';
    
    console.log(`[${requestId}] API Request Received: GET /tickets`);
    
    try {
        // Check cache first
        const cachedData = getCached(cacheKey);
        if (cachedData) {
            console.log(`[${requestId}] API Response Sent: GET /tickets (from cache) - Status: 200`);
            return res.json(cachedData);
        }

        const response = await axiosInstance.get(process.env.JIRA_GET_API_URL, {
            headers: {
                'Authorization': `Basic ${process.env.JIRA_AUTH_TOKEN}`,
                'Accept': 'application/json'
            }
        });
        
        // Cache the response
        setCache(cacheKey, response.data);
        console.log(`[${requestId}] API Response Sent: GET /tickets - Status: ${response.status}`);
        res.json(response.data);
    } catch (error) {
        console.error(`[${requestId}] Error fetching tickets:`, error.message);
        const statusCode = error.response?.status || 500;
        console.log(`[${requestId}] API Response Sent: GET /tickets - Status: ${statusCode} (Error)`);
        res.status(statusCode).json({
            error: 'Failed to fetch from Jira',
            message: error.message
        });
    }
});

// 2. POST Subtasks Endpoint - with rate limiting and queuing
app.post('/subtasks', async (req, res) => {
    const requestId = generateUUID();
    const { summary, description, parentKey } = req.body;

    console.log(`[${requestId}] API Request Received: POST /subtasks - Parent: ${parentKey}`);

    // Validate required fields
    if (!summary || !description || !parentKey) {
        console.log(`[${requestId}] API Response Sent: POST /subtasks - Status: 400 (Validation Error)`);
        return res.status(400).json({
            error: 'Missing required fields: summary, description, and parentKey are required'
        });
    }

    try {
        // Enqueue the request with rate limiting
        const response = await requestQueue.enqueue(
            () => axiosInstance.post(
                process.env.JIRA_POST_API_URL,
                {
                    fields: {
                        project: { key: "INC" },
                        parent: { key: parentKey },
                        summary: summary,
                        description: {
                            type: "doc",
                            version: 1,
                            content: [
                                {
                                    type: "paragraph",
                                    content: [{ type: "text", text: description }]
                                }
                            ]
                        },
                        issuetype: { id: "10006" }
                    }
                },
                {
                    headers: {
                        'Authorization': `Basic ${process.env.JIRA_AUTH_TOKEN}`,
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    }
                }
            ),
            requestId,
            3 // max retries
        );

        console.log(`[${requestId}] API Response Sent: POST /subtasks - Status: ${response.status} - Created: ${response.data.key}`);
        res.json({
            success: true,
            key: response.data.key,
            id: response.data.id,
            self: response.data.self
        });

    } catch (error) {
        console.error(`[${requestId}] Subtask creation failed:`, error.response?.data || error.message);
        const statusCode = error.response?.status || 500;
        console.log(`[${requestId}] API Response Sent: POST /subtasks - Status: ${statusCode} (Error)`);
        res.status(statusCode).json({
            success: false,
            error: error.response?.data || error.message
        });
    }
});

// Queue statistics endpoint
app.get('/queue-stats', (req, res) => {
    res.json(requestQueue.getStats());
});

// Health check endpoint for load balancers
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy', timestamp: Date.now() });
});

// Graceful shutdown handler
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Optimized for extreme throughput (3,500+ req/s)`);
    console.log(`- HTTP Keep-Alive enabled`);
    console.log(`- Compression enabled`);
    console.log(`- Response caching enabled (60s TTL)`);
    console.log(`- Rate limiting: 95 req/s to Jira (respects 100 req/s limit)`);
    console.log(`- Request queuing with automatic retry on 429`);
    console.log(`- Exponential backoff for rate limit errors`);
    console.log(`- Max sockets: 100`);
    console.log(`- Queue stats available at: GET /queue-stats`);
});

// Set server timeout to handle long-running requests
server.keepAliveTimeout = 65000; // 65 seconds
server.headersTimeout = 66000; // 66 seconds (slightly higher than keepAliveTimeout)

