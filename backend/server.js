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
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 4000;

// ============================================
// Configuration
// ============================================

// ModelRiver API settings
const MODELRIVER_API_URL = process.env.MODELRIVER_API_URL || 'https://api.modelriver.com';
const MODELRIVER_API_KEY = process.env.MODELRIVER_API_KEY;

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
app.use(express.json());

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
        // Handle both standard and event-driven webhook formats
        const { channel_id, status, data, meta, callback_url, type, event, ai_response } = req.body;
        
        // For event-driven workflows, callback_url is in the payload
        // For standard webhooks, check header (though it may not be present)
        const callbackUrl = callback_url || req.headers['x-modelriver-callback-url'];
        
        // For event-driven workflows, extract data from ai_response
        const responseData = ai_response?.data || data;

        console.log('\n📥 Webhook received from ModelRiver');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📊 Channel ID:', channel_id);
        console.log('📊 Type:', type || 'standard');
        console.log('📊 Event:', event || 'N/A');
        console.log('📊 Status:', status);
        console.log('📊 Callback URL:', callbackUrl || 'Not provided');

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

        console.log('💾 Simulated DB Save:', {
            id: record.id,
            prompt: record.prompt?.substring(0, 50) + '...',
            response: record.response?.substring(0, 50) + '...'
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
                
                console.log('📤 Sending callback to:', callbackUrl);
                console.log('📊 Channel ID from URL:', urlChannelId);
                console.log('📊 Channel ID from webhook:', channel_id);
                console.log('📊 Full webhook body keys:', Object.keys(req.body));
                console.log('📊 Response data type:', typeof responseData, Array.isArray(responseData));

                try {
                // For event-driven workflows, use ai_response.data directly
                // For standard webhooks, use data
                // The callback expects the actual AI response data, not the extracted content
                let callbackData;
                
                if (type === 'task.ai_generated' && ai_response?.data) {
                    // Event-driven: use ai_response.data as the base
                    callbackData = ai_response.data;
                    console.log('📦 Using ai_response.data for callback');
                } else if (data) {
                    // Standard webhook: use data directly
                    callbackData = data;
                    console.log('📦 Using data for callback');
                } else {
                    // Fallback: use responseData
                    callbackData = responseData || {};
                    console.log('📦 Using responseData as fallback');
                }

                // Inject custom IDs into the callback data
                // ModelRiver expects params["data"] to be a valid object (not null)
                // If callbackData is an object, merge IDs into it
                // Otherwise, wrap it in an object with IDs
                let enrichedData;
                
                if (callbackData && typeof callbackData === 'object' && !Array.isArray(callbackData) && callbackData !== null) {
                    // Object data - merge IDs into it
                    enrichedData = {
                        ...callbackData,
                        id: messageId,
                        conversation_id: conversationId
                    };
                } else if (Array.isArray(callbackData)) {
                    // Array data - wrap in object
                    enrichedData = {
                        items: callbackData,
                        id: messageId,
                        conversation_id: conversationId
                    };
                } else if (callbackData !== null && callbackData !== undefined) {
                    // Primitive or string - wrap in object
                    enrichedData = {
                        content: callbackData,
                        id: messageId,
                        conversation_id: conversationId
                    };
                } else {
                    // Fallback: ensure we always have a valid object
                    enrichedData = {
                        id: messageId,
                        conversation_id: conversationId,
                        message: 'Response processed'
                    };
                }

                // Ensure data is always a valid object (not null)
                const callbackPayload = {
                    data: enrichedData || {},
                    task_id: messageId,
                    metadata: {
                        conversation_id: conversationId,
                        channel_id: channel_id,
                        processed_at: new Date().toISOString(),
                        usage: meta?.usage || data?.usage || ai_response?.meta?.usage || {}
                    }
                };

                // Validate payload before sending
                if (!callbackPayload.data || typeof callbackPayload.data !== 'object' || Array.isArray(callbackPayload.data)) {
                    console.error('❌ Invalid callback payload data structure:', callbackPayload.data);
                    throw new Error('Callback data must be a valid object');
                }

                console.log('📦 Callback payload structure:', {
                    hasData: !!callbackPayload.data,
                    dataType: typeof callbackPayload.data,
                    isArray: Array.isArray(callbackPayload.data),
                    dataKeys: Object.keys(callbackPayload.data),
                    taskId: callbackPayload.task_id,
                    hasMetadata: !!callbackPayload.metadata
                });
                console.log('📦 Callback payload (first 500 chars):', JSON.stringify(callbackPayload).substring(0, 500));

                const callbackResponse = await axios.post(callbackUrl, callbackPayload, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${MODELRIVER_API_KEY}`
                    },
                    timeout: 30000, // 30 second timeout
                    validateStatus: (status) => status < 500 // Don't throw on 4xx errors
                });

                console.log('✅ Callback sent successfully');
                console.log('📥 Callback response status:', callbackResponse.status);
                console.log('📥 Callback response data:', JSON.stringify(callbackResponse.data));
            } catch (callbackError) {
                console.error('❌ Callback failed:', callbackError.message);
                if (callbackError.response) {
                    console.error('❌ Callback error response status:', callbackError.response.status);
                    console.error('❌ Callback error response data:', JSON.stringify(callbackError.response.data, null, 2));
                    console.error('❌ Callback error response headers:', JSON.stringify(callbackError.response.headers, null, 2));
                    
                    // Log the request that was sent for debugging
                    console.error('❌ Callback request that failed:');
                    console.error('  URL:', callbackUrl);
                    console.error('  Method: POST');
                    console.error('  Headers:', JSON.stringify({
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${MODELRIVER_API_KEY ? MODELRIVER_API_KEY.substring(0, 20) + '...' : 'MISSING'}`
                    }, null, 2));
                    console.error('  Payload:', JSON.stringify(callbackPayload, null, 2));
                } else if (callbackError.request) {
                    console.error('❌ Callback request failed - no response received');
                    console.error('❌ Request URL:', callbackUrl);
                    console.error('❌ Request method: POST');
                    console.error('❌ Request config:', {
                        timeout: callbackError.config?.timeout,
                        headers: callbackError.config?.headers
                    });
                } else {
                    console.error('❌ Callback setup error:', callbackError.message);
                    console.error('❌ Error stack:', callbackError.stack);
                }
                }
            }
        } else {
            console.log('⚠️  No callback_url provided - skipping callback');
            console.log('📊 Webhook body keys:', Object.keys(req.body));
            console.log('📊 Headers keys:', Object.keys(req.headers));
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // Acknowledge webhook receipt
        res.json({
            success: true,
            message: 'Webhook processed',
            record_id: messageId
        });

    } catch (error) {
        console.error('❌ Error processing webhook:', error.message);
        res.status(500).json({ error: error.message });
    }
});

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
