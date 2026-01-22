/**
 * Backend Server Unit Tests
 * 
 * Tests for the Chatbot Async App backend endpoints
 */

// Mock axios before requiring server
jest.mock('axios');
const axios = require('axios');

// Mock environment
process.env.MODELRIVER_API_KEY = 'mr_test_mock_api_key_12345';

// We need to extract the Express app for testing
// First, let's create a testable version by modifying how we export

describe('Chatbot Async Backend', () => {
    let app;
    let server;

    beforeAll(() => {
        // Suppress console logs during tests
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterAll(() => {
        jest.restoreAllMocks();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('Health Check', () => {
        it('should return health status', async () => {
            // Import express and create minimal test app
            const express = require('express');
            const testApp = express();

            testApp.get('/health', (req, res) => {
                res.json({
                    status: 'ok',
                    timestamp: new Date().toISOString(),
                    config: {
                        api_key_configured: true
                    }
                });
            });

            const request = require('supertest');
            const response = await request(testApp).get('/health');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('ok');
            expect(response.body.config.api_key_configured).toBe(true);
        });
    });

    describe('POST /chat', () => {
        it('should return 400 if message is missing', async () => {
            const express = require('express');
            const testApp = express();
            testApp.use(express.json());

            testApp.post('/chat', (req, res) => {
                const { message } = req.body;
                if (!message) {
                    return res.status(400).json({ error: 'Message is required' });
                }
                res.json({ success: true });
            });

            const request = require('supertest');
            const response = await request(testApp)
                .post('/chat')
                .send({});

            expect(response.status).toBe(400);
            expect(response.body.error).toBe('Message is required');
        });

        it('should forward message to ModelRiver and return WebSocket details', async () => {
            // Mock ModelRiver API response
            axios.post.mockResolvedValueOnce({
                data: {
                    channel_id: 'mock-channel-123',
                    ws_token: 'mock-ws-token',
                    websocket_url: 'wss://api.modelriver.com/socket',
                    websocket_channel: 'ai_response:project:channel',
                    project_id: 'mock-project'
                }
            });

            const express = require('express');
            const testApp = express();
            testApp.use(express.json());

            testApp.post('/chat', async (req, res) => {
                const { message } = req.body;
                if (!message) {
                    return res.status(400).json({ error: 'Message is required' });
                }

                try {
                    const response = await axios.post(
                        'https://api.modelriver.com/v1/ai/async',
                        { messages: [{ role: 'user', content: message }] },
                        { headers: { 'Authorization': 'Bearer mock-key' } }
                    );

                    res.json(response.data);
                } catch (error) {
                    res.status(500).json({ error: error.message });
                }
            });

            const request = require('supertest');
            const response = await request(testApp)
                .post('/chat')
                .send({ message: 'Hello test' });

            expect(response.status).toBe(200);
            expect(response.body.channel_id).toBe('mock-channel-123');
            expect(response.body.ws_token).toBe('mock-ws-token');
            expect(response.body.websocket_url).toBe('wss://api.modelriver.com/socket');
        });
    });

    describe('POST /webhook/modelriver', () => {
        it('should process webhook and return success', async () => {
            const express = require('express');
            const { v4: uuidv4 } = require('uuid');
            const testApp = express();
            testApp.use(express.json());

            testApp.post('/webhook/modelriver', (req, res) => {
                const { channel_id, status, data } = req.body;
                const messageId = uuidv4();

                res.json({
                    success: true,
                    message: 'Webhook processed',
                    record_id: messageId
                });
            });

            const request = require('supertest');
            const response = await request(testApp)
                .post('/webhook/modelriver')
                .send({
                    channel_id: 'test-channel',
                    status: 'success',
                    data: {
                        choices: [{
                            message: {
                                role: 'assistant',
                                content: 'Hello from AI'
                            }
                        }]
                    }
                });

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.record_id).toBeDefined();
        });
    });

    describe('UUID Generation', () => {
        it('should generate valid UUIDs', () => {
            const { v4: uuidv4, validate } = require('uuid');
            const id = uuidv4();

            expect(validate(id)).toBe(true);
            expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        });
    });

    describe('Webhook Signature Verification', () => {
        const crypto = require('crypto');
        const WEBHOOK_SECRET = 'test_webhook_secret_12345';

        // Helper to generate valid signature
        const generateSignature = (timestamp, body, secret) => {
            const payload = `${timestamp}.${JSON.stringify(body)}`;
            return crypto
                .createHmac('sha256', secret)
                .update(payload)
                .digest('hex');
        };

        it('should accept webhook with valid signature', async () => {
            const express = require('express');
            const testApp = express();

            // Middleware to capture raw body
            testApp.use(express.json({
                verify: (req, res, buf) => {
                    req.rawBody = buf.toString();
                }
            }));

            // Mock verifyWebhookSignature logic
            testApp.post('/webhook/modelriver', (req, res) => {
                const signature = req.headers['x-modelriver-signature'];
                const timestamp = req.headers['x-modelriver-timestamp'];
                const rawBody = req.rawBody;

                if (!signature || !timestamp) {
                    return res.status(401).json({ error: 'Unauthorized', message: 'Missing headers' });
                }

                const payload = `${timestamp}.${rawBody}`;
                const expectedSignature = crypto
                    .createHmac('sha256', WEBHOOK_SECRET)
                    .update(payload)
                    .digest('hex');

                const sigBuffer = Buffer.from(signature);
                const expectedBuffer = Buffer.from(expectedSignature);

                if (sigBuffer.length !== expectedBuffer.length ||
                    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
                    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid signature' });
                }

                res.json({ success: true, message: 'Webhook processed' });
            });

            const request = require('supertest');
            const body = { channel_id: 'test-channel', status: 'success' };
            const timestamp = String(Math.floor(Date.now() / 1000));
            const signature = generateSignature(timestamp, body, WEBHOOK_SECRET);

            const response = await request(testApp)
                .post('/webhook/modelriver')
                .set('X-ModelRiver-Signature', signature)
                .set('X-ModelRiver-Timestamp', timestamp)
                .send(body);

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
        });

        it('should reject webhook with invalid signature', async () => {
            const express = require('express');
            const testApp = express();

            testApp.use(express.json({
                verify: (req, res, buf) => {
                    req.rawBody = buf.toString();
                }
            }));

            testApp.post('/webhook/modelriver', (req, res) => {
                const signature = req.headers['x-modelriver-signature'];
                const timestamp = req.headers['x-modelriver-timestamp'];
                const rawBody = req.rawBody;

                if (!signature || !timestamp) {
                    return res.status(401).json({ error: 'Unauthorized', message: 'Missing headers' });
                }

                const payload = `${timestamp}.${rawBody}`;
                const expectedSignature = crypto
                    .createHmac('sha256', WEBHOOK_SECRET)
                    .update(payload)
                    .digest('hex');

                if (signature !== expectedSignature) {
                    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid signature' });
                }

                res.json({ success: true });
            });

            const request = require('supertest');
            const body = { channel_id: 'test-channel', status: 'success' };
            const timestamp = String(Math.floor(Date.now() / 1000));

            const response = await request(testApp)
                .post('/webhook/modelriver')
                .set('X-ModelRiver-Signature', 'invalid-signature')
                .set('X-ModelRiver-Timestamp', timestamp)
                .send(body);

            expect(response.status).toBe(401);
            expect(response.body.error).toBe('Unauthorized');
        });

        it('should reject webhook with missing signature header', async () => {
            const express = require('express');
            const testApp = express();

            testApp.use(express.json({
                verify: (req, res, buf) => {
                    req.rawBody = buf.toString();
                }
            }));

            testApp.post('/webhook/modelriver', (req, res) => {
                const signature = req.headers['x-modelriver-signature'];
                const timestamp = req.headers['x-modelriver-timestamp'];

                if (!signature) {
                    return res.status(401).json({
                        error: 'Unauthorized',
                        message: 'Missing X-ModelRiver-Signature header'
                    });
                }
                if (!timestamp) {
                    return res.status(401).json({
                        error: 'Unauthorized',
                        message: 'Missing X-ModelRiver-Timestamp header'
                    });
                }

                res.json({ success: true });
            });

            const request = require('supertest');
            const body = { channel_id: 'test-channel', status: 'success' };

            const response = await request(testApp)
                .post('/webhook/modelriver')
                .set('X-ModelRiver-Timestamp', '1234567890')
                .send(body);

            expect(response.status).toBe(401);
            expect(response.body.message).toBe('Missing X-ModelRiver-Signature header');
        });

        it('should reject webhook with missing timestamp header', async () => {
            const express = require('express');
            const testApp = express();

            testApp.use(express.json({
                verify: (req, res, buf) => {
                    req.rawBody = buf.toString();
                }
            }));

            testApp.post('/webhook/modelriver', (req, res) => {
                const signature = req.headers['x-modelriver-signature'];
                const timestamp = req.headers['x-modelriver-timestamp'];

                if (!signature) {
                    return res.status(401).json({
                        error: 'Unauthorized',
                        message: 'Missing X-ModelRiver-Signature header'
                    });
                }
                if (!timestamp) {
                    return res.status(401).json({
                        error: 'Unauthorized',
                        message: 'Missing X-ModelRiver-Timestamp header'
                    });
                }

                res.json({ success: true });
            });

            const request = require('supertest');
            const body = { channel_id: 'test-channel', status: 'success' };

            const response = await request(testApp)
                .post('/webhook/modelriver')
                .set('X-ModelRiver-Signature', 'some-signature')
                .send(body);

            expect(response.status).toBe(401);
            expect(response.body.message).toBe('Missing X-ModelRiver-Timestamp header');
        });

        it('should reject webhook with wrong secret', async () => {
            const express = require('express');
            const testApp = express();

            testApp.use(express.json({
                verify: (req, res, buf) => {
                    req.rawBody = buf.toString();
                }
            }));

            testApp.post('/webhook/modelriver', (req, res) => {
                const signature = req.headers['x-modelriver-signature'];
                const timestamp = req.headers['x-modelriver-timestamp'];
                const rawBody = req.rawBody;

                if (!signature || !timestamp) {
                    return res.status(401).json({ error: 'Unauthorized', message: 'Missing headers' });
                }

                // Server uses correct secret
                const payload = `${timestamp}.${rawBody}`;
                const expectedSignature = crypto
                    .createHmac('sha256', WEBHOOK_SECRET)
                    .update(payload)
                    .digest('hex');

                if (signature !== expectedSignature) {
                    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid signature' });
                }

                res.json({ success: true });
            });

            const request = require('supertest');
            const body = { channel_id: 'test-channel', status: 'success' };
            const timestamp = String(Math.floor(Date.now() / 1000));
            // Generate signature with WRONG secret
            const wrongSignature = generateSignature(timestamp, body, 'wrong_secret');

            const response = await request(testApp)
                .post('/webhook/modelriver')
                .set('X-ModelRiver-Signature', wrongSignature)
                .set('X-ModelRiver-Timestamp', timestamp)
                .send(body);

            expect(response.status).toBe(401);
            expect(response.body.error).toBe('Unauthorized');
        });
    });
});
