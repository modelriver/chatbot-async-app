/**
 * Chatbot Async App - Backend Server
 * 
 * This server handles:
 * 1. POST /chat - Receives messages from React frontend, forwards to ModelRiver
 * 2. POST /webhook/modelriver - Receives webhook from ModelRiver, processes response
 * 
 * Data Flow:
 * React → /chat → ModelRiver (async) → /webhook/modelriver → callback → React (via WS)
 */

require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 4000;

// ============================================
// Configuration
// ============================================

// ModelRiver API settings
const MODELRIVER_API_URL = process.env.MODELRIVER_API_URL || 'https://api.modelriver.com';
const MODELRIVER_API_KEY = process.env.MODELRIVER_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// This server's public URL (for webhook callback)
// In production, this would be your deployed backend URL
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || `http://localhost:${PORT}`;

// ============================================
// In-Memory Storage (simulates database)
// ============================================

const conversations = new Map(); // channelId -> { messages: [], createdAt }
const pendingRequests = new Map(); // channelId -> { prompt, timestamp }

// ============================================
// Middleware
// ============================================

app.use(cors());
app.use(express.json({
    verify: (req, res, buf) => {
        // Store raw body for webhook signature verification
        req.rawBody = buf.toString();
    }
}));

// Request logging
app.use((req, res, next) => {
    console.log(`\n📨 ${req.method} ${req.path}`);
    next();
});

// ============================================
// Routes
// ============================================

/**
 * POST /chat
 * 
 * Receives a chat message from the React frontend.
 * Forwards it to ModelRiver as an async request with a callback_url.
 * 
 * Request Body:
 * {
 *   "message": "User's message",
 *   "conversationId": "optional-existing-conversation-id"
 * }
 * 
 * Response:
 * {
 *   "channel_id": "...",
 *   "ws_token": "...",
 *   "websocket_url": "...",
 *   "websocket_channel": "..."
 * }
 */
app.post('/chat', async (req, res) => {
    try {
        const { message, conversationId, workflow, events } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        if (!MODELRIVER_API_KEY) {
            return res.status(500).json({
                error: 'MODELRIVER_API_KEY not configured. Set it in environment variables.'
            });
        }

        console.log('💬 Chat message received:', message);

        // Generate custom IDs before sending to ModelRiver
        const customConversationId = conversationId || uuidv4();
        const customMessageId = uuidv4();

        // Build the request payload for ModelRiver
        // Note: structured_output is configured in the workflow in ModelRiver, not sent in the request
        const payload = {
            workflow: workflow || 'mr_chatbot_workflow',
            messages: [
                { role: 'user', content: message }
            ],
            // Use websocket delivery so frontend can receive response directly
            delivery_method: 'websocket',
            // Explicitly tell ModelRiver where to send the webhook for this request
            webhook_url: `${BACKEND_PUBLIC_URL}/webhook/modelriver`,
            // Include events to enable callback URL functionality
            events: events || ['webhook_received'],
            metadata: {
                conversation_id: customConversationId,
                message_id: customMessageId,
                original_prompt: message,
                timestamp: Date.now()
            }
        };

        console.log('🚀 Sending to ModelRiver:', MODELRIVER_API_URL);
        console.log('📦 Payload:', JSON.stringify(payload, null, 2));

        // Call ModelRiver async API
        const response = await axios.post(
            `${MODELRIVER_API_URL}/v1/ai/async`,
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${MODELRIVER_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const { channel_id, ws_token, websocket_url, websocket_channel, project_id } = response.data;

        console.log('✅ ModelRiver response:', {
            channel_id,
            websocket_channel,
            websocket_url
        });

        // Store pending request for callback processing
        pendingRequests.set(channel_id, {
            prompt: message,
            timestamp: Date.now(),
            conversationId: customConversationId,
            messageId: customMessageId
        });

        // Return WebSocket connection details to frontend
        res.json({
            channel_id,
            ws_token,
            websocket_url,
            websocket_channel,
            project_id
        });

    } catch (error) {
        console.error('❌ Error in /chat:', error.response?.status, error.response?.data || error.message);
        console.error('❌ Full Error Details:', JSON.stringify(error.response?.data, null, 2));
        res.status(500).json({
            error: error.response?.data?.message || error.message,
            details: error.response?.data
        });
    }
});

/**
 * POST /webhook (fallback route for CLI/webhook forwarding tools)
 * 
 * This route handles webhooks forwarded from CLI tools or other forwarding services
 * that may send to /webhook instead of /webhook/modelriver.
 * It simply forwards to the main webhook handler.
 */
app.post('/webhook', async (req, res) => {
    console.log('📥 Webhook received at /webhook (fallback route)');
    console.log('🔄 Forwarding to /webhook/modelriver handler');

    // Forward to the main webhook handler
    try {
        await processModelRiverWebhook(req, res);
    } catch (error) {
        console.error('❌ Error processing webhook:', error.message);
        console.error('❌ Error stack:', error.stack);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

/**
 * POST /webhook/modelriver
 * 
 * Receives webhook events from ModelRiver when AI response is ready.
 * Simulates saving to database by generating an ID.
 * Sends enriched data back to ModelRiver via callback_url if provided.
 * 
 * Webhook Payload:
 * {
 *   "channel_id": "...",
 *   "status": "success",
 *   "data": { ... },
 *   "meta": { ... }
 * }
 */
app.post('/webhook/modelriver', async (req, res) => {
    try {
        await processModelRiverWebhook(req, res);
    } catch (error) {
        console.error('❌ Error processing webhook:', error.message);
        console.error('❌ Error stack:', error.stack);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

/**
 * Verify webhook signature using HMAC-SHA256
 * 
 * @param {object} req - Express request object with rawBody
 * @returns {{ valid: boolean, error?: string }}
 */
function verifyWebhookSignature(req) {
    const signature = req.headers['x-modelriver-signature'];
    const timestamp = req.headers['x-modelriver-timestamp'];
    const rawBody = req.rawBody;

    // Check for required headers
    if (!signature) {
        return { valid: false, error: 'Missing X-ModelRiver-Signature header' };
    }
    if (!timestamp) {
        return { valid: false, error: 'Missing X-ModelRiver-Timestamp header' };
    }

    // Check for webhook secret configuration
    if (!WEBHOOK_SECRET) {
        console.warn('⚠️  WEBHOOK_SECRET not set - signature verification disabled');
        // In development, allow the request if secret is not configured
        if (process.env.NODE_ENV === 'development') {
            console.warn('⚠️  Development mode: skipping signature verification');
            return { valid: true };
        }
        return { valid: false, error: 'Webhook secret not configured' };
    }

    // Construct the signature payload: "${timestamp}.${json_body}"
    const payload = `${timestamp}.${rawBody}`;

    // Generate expected signature using HMAC-SHA256
    const expectedSignature = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(payload)
        .digest('hex');

    // Constant-time comparison to prevent timing attacks
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    // Check buffer lengths first (if different, signatures can't match)
    if (sigBuffer.length !== expectedBuffer.length) {
        return { valid: false, error: 'Invalid signature' };
    }

    // Use timing-safe comparison
    if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
        return { valid: false, error: 'Invalid signature' };
    }

    return { valid: true };
}

async function processModelRiverWebhook(req, res) {
    try {
        // ============================================
        // Signature Verification
        // ============================================
        const signatureResult = verifyWebhookSignature(req);
        if (!signatureResult.valid) {
            console.error('❌ Webhook signature verification failed:', signatureResult.error);
            return res.status(401).json({
                error: 'Unauthorized',
                message: signatureResult.error
            });
        }
        console.log('✅ Webhook signature verified');

        // Handle both standard and event-driven webhook formats
        // Note: In some cases, event and ai_response are inside data object
        const { channel_id, status, data, meta, callback_url, type, event, ai_response } = req.body;

        // Extract event and ai_response from nested data if not at top level
        const actualEvent = event || data?.event;
        const actualType = type || data?.type;
        const actualAiResponse = ai_response || data?.ai_response;

        // For event-driven workflows, callback_url can be:
        // 1. Top level: callback_url
        // 2. Inside data: data.callback_url
        // 3. In headers: x-modelriver-callback-url
        const callbackUrl = callback_url ||
            data?.callback_url ||
            req.headers['x-modelriver-callback-url'];

        // For event-driven workflows (like new_chat), extract data from ai_response.data
        // This is where the structured response lives
        const responseData = actualAiResponse?.data || data;

        console.log('\n📥 Webhook received from ModelRiver');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📊 Channel ID:', channel_id);
        console.log('📊 Type:', actualType || 'standard');
        console.log('📊 Event:', actualEvent || 'N/A');
        console.log('📊 Status:', status);
        console.log('📊 Callback URL:', callbackUrl || 'Not provided');
        console.log('📊 Has ai_response:', !!actualAiResponse);
        console.log('📊 Has ai_response.data:', !!actualAiResponse?.data);

        // Log if this is a new_chat event
        if (actualEvent === 'new_chat') {
            console.log('🎯 Detected new_chat event!');
            console.log('📦 ai_response.data:', JSON.stringify(actualAiResponse?.data, null, 2));
        }

        // Retrieve pending request info
        const pendingRequest = pendingRequests.get(channel_id) || {};
        const { prompt, conversationId, messageId: customMessageId } = pendingRequest;

        // ============================================
        // Simulate Database Save
        // ============================================

        // Use the custom message ID generated before sending to ModelRiver
        const messageId = customMessageId || uuidv4();

        // Extract the AI response content (handle both structured and unstructured output)
        // For event-driven workflows, use ai_response.data; for standard, use data directly
        let aiResponse;
        const responseDataToProcess = responseData || data;

        if (responseDataToProcess && typeof responseDataToProcess === 'object' && !responseDataToProcess.choices && !responseDataToProcess.response) {
            // Structured output - data is already the structured response
            aiResponse = responseDataToProcess;
        } else {
            // Unstructured output - extract from choices
            aiResponse = responseDataToProcess?.choices?.[0]?.message?.content ||
                responseDataToProcess?.response?.choices?.[0]?.message?.content ||
                JSON.stringify(responseDataToProcess);
        }

        // Create the enriched record (what would be saved to DB)
        const record = {
            id: messageId,
            prompt: prompt || 'Unknown prompt',
            response: aiResponse,
            created_at: new Date().toISOString(),
            channel_id,
            conversation_id: conversationId,
            usage: meta?.usage || data?.usage
        };

        // Helper function to safely truncate response for logging
        const truncateForLog = (value, maxLength = 50) => {
            if (!value) return 'N/A';
            if (typeof value === 'string') {
                return value.length > maxLength ? value.substring(0, maxLength) + '...' : value;
            }
            if (typeof value === 'object') {
                const str = JSON.stringify(value);
                return str.length > maxLength ? str.substring(0, maxLength) + '...' : str;
            }
            return String(value).substring(0, maxLength) + '...';
        };

        console.log('💾 Simulated DB Save:', {
            id: record.id,
            prompt: truncateForLog(record.prompt),
            response: truncateForLog(record.response)
        });

        // Store in memory (simulates DB)
        if (!conversations.has(conversationId)) {
            conversations.set(conversationId, { messages: [], createdAt: new Date() });
        }
        conversations.get(conversationId).messages.push(record);

        // Clean up pending request
        pendingRequests.delete(channel_id);

        // ============================================
        // Send Callback Response (if callback_url provided)
        // ============================================

        if (callbackUrl) {
            // Validate callback URL format
            if (typeof callbackUrl !== 'string' || !callbackUrl.startsWith('http')) {
                console.error('❌ Invalid callback URL format:', callbackUrl);
                console.log('⚠️  Skipping callback due to invalid URL');
            } else {
                // Extract channel_id from callback URL to verify it matches
                const urlMatch = callbackUrl.match(/\/callback\/([^\/\?]+)/);
                const urlChannelId = urlMatch ? urlMatch[1] : null;

                if (urlChannelId && urlChannelId !== channel_id) {
                    console.warn('⚠️  Channel ID mismatch:', {
                        urlChannelId,
                        webhookChannelId: channel_id
                    });
                }

                // ============================================
                // CALLBACK LOGGING - Start
                // ============================================
                const callbackStartTime = Date.now();
                const callbackStartTimestamp = new Date().toISOString();

                console.log('\n🔄 ============================================');
                console.log('🔄 CALLBACK PROCESSING STARTED');
                console.log('🔄 ============================================');
                console.log('🔄 Timestamp:', callbackStartTimestamp);
                console.log('🔄 Channel ID:', channel_id);
                console.log('📤 Sending callback to:', callbackUrl);
                console.log('📊 Channel ID from URL:', urlChannelId);
                console.log('📊 Channel ID from webhook:', channel_id);
                console.log('📊 Full webhook body keys:', Object.keys(req.body));
                console.log('📊 Response data type:', typeof responseData, Array.isArray(responseData));
                console.log('🔄 ============================================\n');

                // Create a promise to track callback completion
                let callbackPromise;

                try {
                    // For new_chat event, use ai_response.data directly
                    // For other event-driven workflows, also use ai_response.data
                    // For standard webhooks, use data
                    let callbackData;

                    if (actualEvent === 'new_chat' && actualAiResponse?.data) {
                        // new_chat event: use ai_response.data directly
                        callbackData = actualAiResponse.data;
                        console.log('📦 Using ai_response.data for new_chat event');
                    } else if (actualType === 'task.ai_generated' && actualAiResponse?.data) {
                        // Other event-driven: use ai_response.data as the base
                        callbackData = actualAiResponse.data;
                        console.log('📦 Using ai_response.data for event-driven callback');
                    } else if (data) {
                        // Standard webhook: use data directly
                        callbackData = data;
                        console.log('📦 Using data for callback');
                    } else {
                        // Fallback: use responseData
                        callbackData = responseData || {};
                        console.log('📦 Using responseData as fallback');
                    }

                    // Simply add id to the AI response data
                    // ModelRiver expects data to be inside a "data" field
                    const callbackPayload = {
                        data: {
                            ...callbackData,
                            id: messageId
                        },
                        task_id: messageId
                    };

                    console.log('📦 Callback payload structure:', {
                        dataKeys: Object.keys(callbackPayload.data),
                        hasReply: !!callbackPayload.data.reply,
                        hasSummary: !!callbackPayload.data.summary,
                        hasSentiment: !!callbackPayload.data.sentiment,
                        id: callbackPayload.data.id
                    });
                    console.log('📦 Callback payload (first 500 chars):', JSON.stringify(callbackPayload).substring(0, 500));
                    console.log('🔄 About to send callback POST request...');
                    console.log('🔄 Request URL:', callbackUrl);
                    console.log('🔄 Request method: POST');
                    console.log('🔄 Request timeout: 30000ms');

                    // Track callback promise
                    const callbackRequestStartTime = Date.now();
                    callbackPromise = axios.post(callbackUrl, callbackPayload, {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${MODELRIVER_API_KEY}`
                        },
                        timeout: 30000, // 30 second timeout
                        validateStatus: (status) => status < 500 // Don't throw on 4xx errors
                    });

                    console.log('🔄 Callback promise created, awaiting response...');

                    const callbackResponse = await callbackPromise;

                    const callbackRequestDuration = Date.now() - callbackRequestStartTime;
                    const callbackTotalDuration = Date.now() - callbackStartTime;
                    const callbackEndTimestamp = new Date().toISOString();

                    console.log('\n✅ ============================================');
                    console.log('✅ CALLBACK SENT SUCCESSFULLY');
                    console.log('✅ ============================================');
                    console.log('✅ End timestamp:', callbackEndTimestamp);
                    console.log('✅ Request duration:', callbackRequestDuration, 'ms');
                    console.log('✅ Total callback processing duration:', callbackTotalDuration, 'ms');
                    console.log('✅ Callback response status:', callbackResponse.status);
                    console.log('✅ Callback response headers:', JSON.stringify(callbackResponse.headers, null, 2));
                    console.log('✅ Callback response data:', JSON.stringify(callbackResponse.data, null, 2));
                    console.log('✅ Channel ID:', channel_id);
                    console.log('✅ ============================================\n');
                } catch (callbackError) {
                    const callbackErrorDuration = Date.now() - callbackStartTime;
                    const callbackErrorTimestamp = new Date().toISOString();

                    console.error('\n❌ ============================================');
                    console.error('❌ CALLBACK FAILED');
                    console.error('❌ ============================================');
                    console.error('❌ Error timestamp:', callbackErrorTimestamp);
                    console.error('❌ Error duration:', callbackErrorDuration, 'ms');
                    console.error('❌ Channel ID:', channel_id);
                    console.error('❌ Callback URL:', callbackUrl);
                    console.error('❌ Error message:', callbackError.message);
                    console.error('❌ Error name:', callbackError.name);

                    if (callbackError.response) {
                        // Server responded with error status
                        console.error('❌ ============================================');
                        console.error('❌ SERVER RESPONSE ERROR');
                        console.error('❌ ============================================');
                        console.error('❌ Response status:', callbackError.response.status);
                        console.error('❌ Response status text:', callbackError.response.statusText);
                        console.error('❌ Response data:', JSON.stringify(callbackError.response.data, null, 2));
                        console.error('❌ Response headers:', JSON.stringify(callbackError.response.headers, null, 2));

                        // Log the request that was sent for debugging
                        console.error('❌ ============================================');
                        console.error('❌ REQUEST THAT FAILED');
                        console.error('❌ ============================================');
                        console.error('❌ URL:', callbackUrl);
                        console.error('❌ Method: POST');
                        console.error('❌ Headers:', JSON.stringify({
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${MODELRIVER_API_KEY ? MODELRIVER_API_KEY.substring(0, 20) + '...' : 'MISSING'}`
                        }, null, 2));
                        console.error('❌ Payload:', JSON.stringify(callbackPayload, null, 2));
                    } else if (callbackError.request) {
                        // Request was made but no response received
                        console.error('❌ ============================================');
                        console.error('❌ NO RESPONSE RECEIVED');
                        console.error('❌ ============================================');
                        console.error('❌ Request was sent but no response received');
                        console.error('❌ Request URL:', callbackUrl);
                        console.error('❌ Request method: POST');
                        console.error('❌ Request timeout:', callbackError.config?.timeout, 'ms');
                        console.error('❌ Request config:', {
                            timeout: callbackError.config?.timeout,
                            headers: callbackError.config?.headers ? Object.keys(callbackError.config.headers) : 'N/A'
                        });
                        console.error('❌ This usually means:');
                        console.error('   - Network error');
                        console.error('   - Server is down');
                        console.error('   - Request timed out');
                        console.error('   - Connection refused');
                    } else {
                        // Error in request setup
                        console.error('❌ ============================================');
                        console.error('❌ REQUEST SETUP ERROR');
                        console.error('❌ ============================================');
                        console.error('❌ Error occurred while setting up request');
                        console.error('❌ Error message:', callbackError.message);
                        console.error('❌ Error stack:', callbackError.stack);
                    }

                    console.error('❌ ============================================\n');

                    // Track promise rejection
                    if (callbackPromise) {
                        callbackPromise.catch((err) => {
                            console.error('❌ Callback promise rejected:', err.message);
                        });
                    }
                }
            }
        } else {
            console.log('⚠️  No callback_url provided - skipping callback');
            console.log('📊 Webhook body keys:', Object.keys(req.body));
            console.log('📊 Headers keys:', Object.keys(req.headers));
            console.log('\n📦 Full Webhook Response:');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(JSON.stringify(req.body, null, 2));
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

            // Also print structured view of key fields
            if (data) {
                console.log('\n📊 Webhook Data:');
                console.log(JSON.stringify(data, null, 2));
            }
            if (ai_response) {
                console.log('\n📊 AI Response:');
                console.log(JSON.stringify(ai_response, null, 2));
            }
            if (meta) {
                console.log('\n📊 Meta:');
                console.log(JSON.stringify(meta, null, 2));
            }
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // Acknowledge webhook receipt
        // Note: This response is sent immediately after callback is initiated
        // The callback itself is handled asynchronously and logged separately
        const webhookResponseTime = new Date().toISOString();
        console.log('📤 Sending webhook acknowledgment response at:', webhookResponseTime);
        console.log('📤 Channel ID:', channel_id);
        console.log('📤 Message ID:', messageId);

        res.json({
            success: true,
            message: 'Webhook processed',
            record_id: messageId,
            channel_id: channel_id,
            timestamp: webhookResponseTime
        });

        console.log('✅ Webhook acknowledgment sent');

    } catch (error) {
        console.error('❌ Error processing webhook:', error.message);
        res.status(500).json({ error: error.message });
    }
}

/**
 * GET /conversations/:id
 * 
 * Retrieve conversation history (from in-memory storage)
 */
app.get('/conversations/:id', (req, res) => {
    const conversation = conversations.get(req.params.id);

    if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json(conversation);
});

/**
 * GET /health
 * 
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        config: {
            modelriver_api_url: MODELRIVER_API_URL,
            backend_public_url: BACKEND_PUBLIC_URL,
            api_key_configured: !!MODELRIVER_API_KEY
        }
    });
});

// ============================================
// Start Server
// ============================================

app.listen(PORT, () => {
    console.log('\n🚀 Chatbot Async Backend');
    console.log('========================');
    console.log(`📡 Server running on http://localhost:${PORT}`);
    console.log(`💬 Chat endpoint: POST http://localhost:${PORT}/chat`);
    console.log(`📥 Webhook endpoint: POST http://localhost:${PORT}/webhook/modelriver`);
    console.log(`❤️  Health check: GET http://localhost:${PORT}/health`);
    console.log('');

    if (MODELRIVER_API_KEY) {
        console.log('✅ MODELRIVER_API_KEY is configured');
    } else {
        console.log('⚠️  MODELRIVER_API_KEY not set - set it in environment variables');
    }

    console.log('\nWaiting for requests...\n');
});
