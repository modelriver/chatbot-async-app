/**
 * Chatbot Async App - Main React Component
 * 
 * This component provides a chat interface that:
 * 1. Sends messages to the backend (/chat endpoint)
 * 2. Receives WebSocket connection details
 * 3. Connects to ModelRiver WebSocket to receive AI responses using @modelriver/client
 * 
 * Data Flow:
 * User Message → Backend → ModelRiver → WebSocket → This Component
 */

import { useState, useRef, useEffect } from 'react'
import { useModelRiver } from '@modelriver/client/react'
import './App.css'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import StructuredResponse from './StructuredResponse'


// Backend API URL
const BACKEND_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

function App() {
    // ============================================
    // State
    // ============================================

    const [messages, setMessages] = useState([])
    const [inputValue, setInputValue] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState(null)
    const [devMode, setDevMode] = useState(false)

    // Refs
    const messagesEndRef = useRef(null)
    const isConnectingRef = useRef(false) // Guard to prevent multiple simultaneous connection attempts
    const processedChannelsRef = useRef(new Set()) // Track processed channel IDs to prevent duplicate messages

    // ============================================
    // ModelRiver Client Hook
    // ============================================

    const {
        connect,
        disconnect,
        reset,
        response,
        error: modelRiverError,
        isConnected,
        isConnecting,
        steps,
        connectionState
    } = useModelRiver({
        baseUrl: 'wss://api.modelriver.com/socket',
        persist: true,
        debug: false
    })

    // ============================================
    // Auto-scroll to bottom when new messages arrive
    // ============================================

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [messages])

    // Handle ModelRiver response
    useEffect(() => {
        if (response) {
            // Extract metadata and status
            const meta = response.meta || {};
            const status = meta.status || response.status || 'pending';
            const isStructured = meta.structured_output === true;

            console.log('📥 WebSocket response received:', { status, hasData: !!response.data, isStructured, time: new Date().toISOString() });
            console.log('📦 Full response object:', response);
            console.log('📦 Full response.data:', response.data);
            console.log('📦 Full response.ai_response:', response.ai_response);
            console.log('📦 Full response.meta:', response.meta);
            console.log('📦 Response keys:', Object.keys(response));

            // Check if data might be in meta.data or meta.ai_response
            if (response.meta?.data) {
                console.log('📦 Found data in meta.data:', response.meta.data);
            }
            if (response.meta?.ai_response) {
                console.log('📦 Found ai_response in meta:', response.meta.ai_response);
            }


            // Only process and display messages when:
            // 1. status is "success" or "completed" OR
            // 2. we have valid ai_response.data with structured fields (before callback completes)
            const hasAiResponseData = response.ai_response?.data &&
                (response.ai_response.data.reply || response.ai_response.data.summary || response.ai_response.data.sentiment);

            if (status === 'success' || status === 'completed' || hasAiResponseData) {
                // Extract AI response content from various possible locations
                // After callback, ModelRiver sends the data in different places:
                // 1. response.reply, response.summary etc. (direct from callback payload)
                // 2. response.ai_response.data (before callback)
                // 3. response.data (standard webhook)

                // Check if response itself has the structured fields directly
                const hasDirectFields = response.reply || response.summary || response.sentiment;

                let responseData;
                // Priority 1: Check ai_response.data first (this is where data comes before callback)
                if (response.ai_response?.data &&
                    (response.ai_response.data.reply || response.ai_response.data.summary || response.ai_response.data.sentiment)) {
                    responseData = response.ai_response.data;
                    console.log('📍 Using response.ai_response.data');
                }
                // Priority 2: Check meta.ai_response.data (might be in meta)
                else if (response.meta?.ai_response?.data &&
                    (response.meta.ai_response.data.reply || response.meta.ai_response.data.summary || response.meta.ai_response.data.sentiment)) {
                    responseData = response.meta.ai_response.data;
                    console.log('📍 Using response.meta.ai_response.data');
                }
                // Priority 3: Check meta.data 
                else if (response.meta?.data &&
                    (response.meta.data.reply || response.meta.data.summary || response.meta.data.sentiment)) {
                    responseData = response.meta.data;
                    console.log('📍 Using response.meta.data');
                }
                // Priority 4: Check if structured fields are directly on response (after callback)
                else if (hasDirectFields) {
                    responseData = response;
                    console.log('📍 Using response directly (callback payload)');
                }
                // Priority 5: Check response.data
                else if (response.data?.reply || response.data?.summary || response.data?.sentiment) {
                    responseData = response.data;
                    console.log('📍 Using response.data');
                }
                // Priority 6: Check message if it's an object with data
                else if (response.message && typeof response.message === 'object' &&
                    (response.message.reply || response.message.summary || response.message.sentiment)) {
                    responseData = response.message;
                    console.log('📍 Using response.message');
                }
                // Fallback
                else {
                    responseData = response.data;
                    console.log('📍 Using response.data as fallback');
                }

                console.log('📦 Extracted responseData:', responseData);

                // Skip if responseData is empty or invalid
                const hasValidData = responseData && Object.keys(responseData).length > 0 &&
                    (responseData.reply || responseData.summary || responseData.sentiment || responseData.choices);

                if (!hasValidData) {
                    console.log('⚠️ Skipping empty responseData');
                    return;
                }

                // Deduplicate: Skip if we already processed this channel_id
                const channelId = response.channel_id;
                if (channelId && processedChannelsRef.current.has(channelId)) {
                    console.log('⚠️ Skipping duplicate response for channel:', channelId);
                    return;
                }

                // Mark this channel as processed
                if (channelId) {
                    processedChannelsRef.current.add(channelId);
                    console.log('✅ Marking channel as processed:', channelId);
                }

                let aiContent;
                if (isStructured || (responseData && typeof responseData === 'object' && !responseData.choices && !Array.isArray(responseData))) {
                    // Structured output - format as JSON
                    aiContent = JSON.stringify(responseData, null, 2);
                } else {
                    // Unstructured output - extract from reply or choices
                    aiContent = responseData?.reply ||
                        responseData?.choices?.[0]?.message?.content ||
                        response.content ||
                        JSON.stringify(responseData);
                }

                // Extract usage and model info
                const usage = meta.usage || {};
                const model = meta.used_model || meta.model || 'unknown';

                // Add assistant message to chat only when status is success
                setMessages(prev => [...prev, {
                    id: Date.now(),
                    role: 'assistant',
                    content: aiContent,
                    timestamp: new Date().toISOString(),
                    meta: {
                        ...meta,
                        ...usage,
                        model,
                        channelId: response.channel_id,
                        isStructured: isStructured || (typeof responseData === 'object' && !responseData.choices && !Array.isArray(responseData))
                    }
                }]);

                setIsLoading(false);

                // If status is "completed" or "success", explicitly disconnect to prevent reconnection attempts
                // Both statuses indicate workflow completion
                if (status === 'completed' || status === 'success') {
                    console.log(`✅ Workflow completed (status: ${status}) - explicitly disconnecting to prevent reconnection`);
                    disconnect();
                    // Clear the connection guard
                    isConnectingRef.current = false;
                }
            } else if (status === 'error') {
                // Handle error status
                const errorMessage = response.error?.message || response.message || 'An error occurred';
                setError(errorMessage);
                setMessages(prev => [...prev, {
                    id: Date.now(),
                    role: 'assistant',
                    content: `❌ Error: ${errorMessage}`,
                    timestamp: new Date().toISOString(),
                    isError: true
                }]);
                setIsLoading(false);
                // Don't call disconnect() here - the client will handle connection cleanup
            } else if (status === 'pending') {
                // Keep loading state for pending status - typing indicator will show
                console.log('⏳ Response status is pending - showing typing indicator');
                // Don't set isLoading to false, keep it true to show typing indicator
            } else {
                // Unknown status - log and keep loading
                console.log('⚠️ Unknown response status:', status);
            }
        }
    }, [response]); // Removed disconnect from dependencies to prevent unnecessary re-renders

    // Handle ModelRiver errors
    useEffect(() => {
        if (modelRiverError) {
            setError(modelRiverError);
            setMessages(prev => [...prev, {
                id: Date.now(),
                role: 'assistant',
                content: `❌ Error: ${modelRiverError}`,
                timestamp: new Date().toISOString(),
                isError: true
            }]);
            setIsLoading(false);
        }
    }, [modelRiverError]);

    // Cleanup on unmount - use ref to avoid dependency issues
    const disconnectRef = useRef(disconnect);
    useEffect(() => {
        disconnectRef.current = disconnect;
    }, [disconnect]);

    useEffect(() => {
        return () => {
            // Only disconnect on actual unmount, not on every render
            disconnectRef.current();
        };
    }, []); // Empty dependency array - only run on unmount


    // ============================================
    // Send Message Handler
    // ============================================

    const sendMessage = async () => {
        if (!inputValue.trim() || isLoading) return

        const userMessage = inputValue.trim()
        setInputValue('')
        setError(null)
        setIsLoading(true)

        // Add user message to chat immediately
        setMessages(prev => [...prev, {
            id: Date.now(),
            role: 'user',
            content: userMessage,
            timestamp: new Date().toISOString()
        }])

        try {
            // Prevent multiple simultaneous connection attempts
            if (isConnectingRef.current) {
                console.log('⚠️ Connection already in progress, skipping...');
                return;
            }

            // Step 1: Send message to backend
            console.log('📤 Sending message to backend...')

            const backendResponse = await fetch(`${BACKEND_URL}/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: userMessage
                })
            })

            if (!backendResponse.ok) {
                const errorData = await backendResponse.json()
                throw new Error(errorData.error || `HTTP ${backendResponse.status}`)
            }

            const data = await backendResponse.json()
            console.log('✅ Backend response:', data)

            // Step 2: Connect to ModelRiver WebSocket using the client SDK
            const { channel_id, ws_token, websocket_url, websocket_channel } = data

            if (!channel_id || !ws_token || !websocket_url || !websocket_channel) {
                throw new Error('Missing WebSocket connection details from backend')
            }

            // Check if we have a completed response from a previous request
            // If so, reset the hook state before connecting to a new channel
            if (response && (response.status === 'completed' || response.meta?.status === 'completed')) {
                console.log('⚠️ Previous response is completed, resetting hook state before new connection');
                reset(); // Reset hook state to clear completed response
                // Small delay to ensure reset completes
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // Disconnect any existing connection before connecting to a new one
            // This prevents multiple connections from accumulating
            // Only disconnect if we're currently connected or connecting
            if (isConnected || isConnecting) {
                console.log('🔌 Disconnecting existing connection before new connection');
                disconnect();
                // Small delay to ensure disconnect completes
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // Set connection guard
            isConnectingRef.current = true;

            // Connect using ModelRiver client
            console.log('🔌 Connecting to new channel:', channel_id);
            connect({
                channelId: channel_id,
                wsToken: ws_token,
                websocketUrl: websocket_url,
                websocketChannel: websocket_channel
            });

            // Reset connection guard after a short delay (connection should be initiated)
            setTimeout(() => {
                isConnectingRef.current = false;
            }, 500);

        } catch (err) {
            console.error('❌ Error sending message:', err)
            setError(err.message)
            setIsLoading(false)
        }
    }

    // ============================================
    // Handle Enter Key
    // ============================================

    const handleKeyPress = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            sendMessage()
        }
    }

    // ============================================
    // Render
    // ============================================

    return (
        <div className="chat-container">
            {/* Header */}
            <header className="chat-header">
                <div className="header-left">
                    <h1>💬 Chatbot Async App</h1>
                    <div className={`connection-status ${connectionState}`}>
                        <span className="status-dot"></span>
                        <span className="status-text">
                            {isConnecting ? 'Connecting...' :
                                isConnected ? 'Connected' :
                                    connectionState === 'error' ? 'Error' : 'Disconnected'}
                        </span>
                    </div>
                </div>
                <div className="header-right">
                    <label className="dev-mode-toggle">
                        <input
                            type="checkbox"
                            checked={devMode}
                            onChange={(e) => setDevMode(e.target.checked)}
                        />
                        <span className="slider"></span>
                        <span className="label-text">Dev Mode</span>
                    </label>
                </div>
            </header>

            {/* Messages */}
            <div className="messages-container">
                {messages.length === 0 ? (
                    <div className="empty-state">
                        <p>👋 Send a message to start chatting!</p>
                        <p className="hint">Your messages are processed through ModelRiver's async API</p>
                    </div>
                ) : (
                    messages.map((message) => (
                        <div
                            key={message.id}
                            className={`message ${message.role}${message.isError ? ' error' : ''}`}
                        >
                            <div className="message-avatar">
                                {message.role === 'user' ? '👤' : message.isError ? '⚠️' : '🤖'}
                            </div>
                            <div className="message-content">
                                <div className="message-text">
                                    {message.role === 'assistant' && !message.isError ? (
                                        message.meta?.isStructured ? (
                                            // Structured output - show with StructuredResponse component
                                            <StructuredResponse data={message.content} />
                                        ) : (
                                            // Unstructured output - render as markdown
                                            <ReactMarkdown
                                                remarkPlugins={[remarkGfm]}
                                                components={{
                                                    code({ node, inline, className, children, ...props }) {
                                                        const match = /language-(\w+)/.exec(className || '')
                                                        return !inline && match ? (
                                                            <SyntaxHighlighter
                                                                style={vscDarkPlus}
                                                                language={match[1]}
                                                                PreTag="div"
                                                                {...props}
                                                            >
                                                                {String(children).replace(/\n$/, '')}
                                                            </SyntaxHighlighter>
                                                        ) : (
                                                            <code className={className} {...props}>
                                                                {children}
                                                            </code>
                                                        )
                                                    }
                                                }}
                                            >
                                                {message.content}
                                            </ReactMarkdown>
                                        )
                                    ) : (
                                        message.content
                                    )}
                                </div>
                                {devMode && message.meta && (
                                    <div className="message-metadata">
                                        <div className="meta-item">🆔 {message.meta.channelId?.slice(0, 8)}...</div>
                                        <div className="meta-item">🤖 {message.meta.model}</div>
                                        {message.meta.duration_ms && (
                                            <div className="meta-item">⏱️ {message.meta.duration_ms}ms</div>
                                        )}
                                        {message.meta.isStructured && (
                                            <div className="meta-item">📋 Structured Output</div>
                                        )}
                                    </div>
                                )}
                                {devMode && steps.length > 0 && (
                                    <div className="workflow-steps">
                                        {steps.map((step) => (
                                            <div key={step.id} className={`step step-${step.status}`}>
                                                {step.name} - {step.status}
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <div className="message-time">
                                    {new Date(message.timestamp).toLocaleTimeString()}
                                </div>
                            </div>
                        </div>
                    ))
                )}

                {/* Loading indicator - show when loading or when response status is pending */}
                {(isLoading || (response && (response.meta?.status === 'pending' || response.status === 'pending'))) && (
                    <div className="message assistant loading">
                        <div className="message-avatar">🤖</div>
                        <div className="message-content">
                            <div className="typing-indicator">
                                <span></span>
                                <span></span>
                                <span></span>
                            </div>
                            <div className="message-time">
                                {new Date().toLocaleTimeString()}
                            </div>
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Error Display */}
            {error && (
                <div className="error-banner">
                    ⚠️ {error}
                    <button onClick={() => setError(null)}>✕</button>
                </div>
            )}

            {/* Input Area */}
            <div className="input-container">
                <textarea
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyPress={handleKeyPress}
                    placeholder="Type your message..."
                    disabled={isLoading}
                    rows={Math.min(5, Math.max(1, inputValue.split('\n').length))}
                    autoComplete="off"
                    spellCheck="true"
                />
                <button
                    onClick={sendMessage}
                    disabled={isLoading || !inputValue.trim()}
                    className="send-button"
                >
                    {isLoading ? '⏳' : '📤'}
                </button>
            </div>
        </div>
    )
}

export default App
