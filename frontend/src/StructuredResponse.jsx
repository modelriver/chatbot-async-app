/**
 * StructuredResponse Component
 * 
 * Displays AI-generated structured responses in a user-friendly format
 * with sentiment indicators, confidence scores, topics, and action items.
 */

import React from 'react';
import './StructuredResponse.css';

const StructuredResponse = ({ data }) => {
    // Parse data if it's a string
    const parsedData = typeof data === 'string' ? JSON.parse(data) : data;

    // Extract the actual data object (it might be nested in response.data)
    const responseData = parsedData.data || parsedData;

    // Debug logging
    console.log('🔍 StructuredResponse data:', { parsedData, responseData });

    const {
        summary,
        sentiment,
        confidence,
        topics = [],
        action_items = [],
        message, // The actual message content from the AI
        reply // The AI's reply/answer to the user's question
    } = responseData;

    // Sentiment emoji mapping
    const getSentimentEmoji = (sentiment) => {
        const sentimentMap = {
            'positive': '😊',
            'neutral': '😐',
            'negative': '😟',
            'mixed': '🤔'
        };
        return sentimentMap[sentiment?.toLowerCase()] || '💬';
    };

    // Confidence color mapping
    const getConfidenceColor = (confidence) => {
        if (confidence >= 0.8) return '#4ade80'; // green
        if (confidence >= 0.6) return '#fbbf24'; // yellow
        return '#f87171'; // red
    };

    // Priority emoji mapping
    const getPriorityEmoji = (priority) => {
        const priorityMap = {
            'high': '🔴',
            'medium': '🟡',
            'low': '🟢'
        };
        return priorityMap[priority?.toLowerCase()] || '⚪';
    };

    return (
        <div className="structured-response">
            {/* Header with Sentiment and Confidence */}
            <div className="response-header">
                <div className="sentiment-indicator">
                    <span className="sentiment-emoji">{getSentimentEmoji(sentiment)}</span>
                    <span className="sentiment-label">{sentiment || 'neutral'}</span>
                </div>
                {confidence !== undefined && (
                    <div className="confidence-indicator">
                        <div className="confidence-bar-container">
                            <div
                                className="confidence-bar"
                                style={{
                                    width: `${confidence * 100}%`,
                                    backgroundColor: getConfidenceColor(confidence)
                                }}
                            />
                        </div>
                        <span className="confidence-label">
                            {(confidence * 100).toFixed(0)}% confident
                        </span>
                    </div>
                )}
            </div>

            {/* Reply - Main AI Response */}
            {reply && (
                <div className="response-reply">
                    <p>{reply}</p>
                </div>
            )}

            {/* Message Content */}
            {message && (
                <div className="response-message">
                    <h4>💬 Status</h4>
                    <p>{message}</p>
                </div>
            )}

            {/* Summary */}
            {summary && (
                <div className="response-summary">
                    <h4>📝 Summary</h4>
                    <p>{summary}</p>
                </div>
            )}

            {/* Topics */}
            {topics.length > 0 && (
                <div className="response-topics">
                    <h4>📌 Topics</h4>
                    <div className="topics-list">
                        {topics.map((topic, index) => (
                            <span key={index} className="topic-tag">
                                {topic}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {/* Action Items */}
            {action_items.length > 0 && (
                <div className="response-actions">
                    <h4>✅ Action Items</h4>
                    <ul className="actions-list">
                        {action_items.map((item, index) => (
                            <li key={index} className={`action-item priority-${item.priority?.toLowerCase()}`}>
                                <span className="priority-indicator">
                                    {getPriorityEmoji(item.priority)}
                                </span>
                                <span className="action-text">{item.task}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
};

export default StructuredResponse;
